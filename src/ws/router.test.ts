/// <reference lib="deno.ns" />
/**
 * dispatchWs + wsData: matcher dispatch, error envelopes, fire-and-forget,
 * streaming, abort propagation.
 *
 * Pure unit — no rig, no socket. `rig` is a typed-cast stub the routes
 * never touch; every route supplies its own action.
 */

import { assertEquals } from "@std/assert";
import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import { BadRequest, InternalError } from "../router/errors.ts";
import type { WebSocketRequest, WebSocketResponse } from "./client.ts";
import { dispatchWs, route, wsData } from "./router.ts";

const fakeRig = {} as Rig;

function frame(
  type: WebSocketRequest["type"],
  payload: unknown = {},
  id = "f1",
): WebSocketRequest {
  return { id, type, payload };
}

async function collect(
  it: AsyncIterable<WebSocketResponse>,
): Promise<WebSocketResponse[]> {
  const out: WebSocketResponse[] = [];
  for await (const r of it) out.push(r);
  return out;
}

// ── wsData (matcher generator) ──

Deno.test("wsData: returns true on type match, null otherwise", () => {
  const m = wsData("receive");
  assertEquals(m(frame("receive")), true);
  assertEquals(m(frame("read")), null);
  assertEquals(m(frame("observe-cancel")), null);
});

// ── dispatchWs: matching ──

Deno.test("dispatchWs: no matching route → `Unknown type` error envelope", async () => {
  const out = await collect(
    dispatchWs(fakeRig, [], frame("receive"), new AbortController()),
  );
  assertEquals(out, [
    { id: "f1", success: false, error: "Unknown type: receive" },
  ]);
});

Deno.test("dispatchWs: first matching route wins", async () => {
  const first = route({
    on: wsData("receive"),
    decode: () => [] as const,
    action: () => "first",
    encode: (data, { id }) => ({ id, success: true, data }),
  });
  const second = route({
    on: wsData("receive"),
    decode: () => [] as const,
    action: () => "second",
    encode: (data, { id }) => ({ id, success: true, data }),
  });
  const out = await collect(
    dispatchWs(
      fakeRig,
      [first, second],
      frame("receive"),
      new AbortController(),
    ),
  );
  assertEquals(out, [{ id: "f1", success: true, data: "first" }]);
});

Deno.test("dispatchWs: custom matcher (not wsData) participates", async () => {
  const r = route({
    on: (f) => (f.payload as { magic?: boolean })?.magic ? true : null,
    decode: () => [] as const,
    action: () => "ok",
    encode: (d, { id }) => ({ id, success: true, data: d }),
  });
  const hit = await collect(
    dispatchWs(
      fakeRig,
      [r],
      frame("receive", { magic: true }),
      new AbortController(),
    ),
  );
  assertEquals(hit, [{ id: "f1", success: true, data: "ok" }]);

  const miss = await collect(
    dispatchWs(
      fakeRig,
      [r],
      frame("receive", { magic: false }),
      new AbortController(),
    ),
  );
  assertEquals(miss[0].success, false);
  assertEquals(miss[0].error, "Unknown type: receive");
});

// ── dispatchWs: ctx wiring ──

Deno.test("dispatchWs: ctx exposes id, payload, abort", async () => {
  let seen: { id?: string; payload?: unknown; aborted?: boolean } = {};
  const r = route({
    on: wsData("read"),
    decode: ({ id, payload, abort }) => {
      seen = { id, payload, aborted: abort.signal.aborted };
      return [] as const;
    },
    action: () => null,
    encode: (_d, { id }) => ({ id, success: true, data: null }),
  });
  const abort = new AbortController();
  await collect(
    dispatchWs(fakeRig, [r], frame("read", { urls: ["x"] }, "abc"), abort),
  );
  assertEquals(seen.id, "abc");
  assertEquals(seen.payload, { urls: ["x"] });
  assertEquals(seen.aborted, false);
});

Deno.test("dispatchWs: action receives the same abort signal as ctx", async () => {
  let actionSignal: AbortSignal | null = null;
  const r = route({
    on: wsData("status"),
    decode: () => [] as const,
    action: (_rig, _args, signal) => {
      actionSignal = signal;
      return null;
    },
    encode: (_d, { id }) => ({ id, success: true, data: null }),
  });
  const abort = new AbortController();
  await collect(dispatchWs(fakeRig, [r], frame("status"), abort));
  assertEquals(actionSignal, abort.signal);
});

Deno.test("dispatchWs: action receives forwarded args from decode", async () => {
  let seenArgs: unknown = null;
  const r = route({
    on: wsData("receive"),
    decode: ({ payload }) => [payload, 42] as const,
    action: (_rig, args) => {
      seenArgs = args;
      return null;
    },
    encode: (_d, { id }) => ({ id, success: true, data: null }),
  });
  await collect(
    dispatchWs(
      fakeRig,
      [r],
      frame("receive", { hello: "world" }),
      new AbortController(),
    ),
  );
  assertEquals(seenArgs, [{ hello: "world" }, 42]);
});

// ── dispatchWs: error rendering ──

Deno.test("dispatchWs: decode throwing BadRequest → error envelope with message", async () => {
  const r = route({
    on: wsData("receive"),
    decode: () => {
      throw new BadRequest("bad payload");
    },
    action: () => null,
    encode: () => ({ id: "x", success: true }),
  });
  const out = await collect(
    dispatchWs(fakeRig, [r], frame("receive"), new AbortController()),
  );
  assertEquals(out, [{ id: "f1", success: false, error: "bad payload" }]);
});

Deno.test("dispatchWs: action throwing arbitrary Error → error envelope", async () => {
  const r = route({
    on: wsData("status"),
    decode: () => [] as const,
    action: () => {
      throw new Error("kaboom");
    },
    encode: () => ({ id: "x", success: true }),
  });
  const out = await collect(
    dispatchWs(fakeRig, [r], frame("status"), new AbortController()),
  );
  assertEquals(out, [{ id: "f1", success: false, error: "kaboom" }]);
});

Deno.test("dispatchWs: encode throwing → error envelope", async () => {
  const r = route({
    on: wsData("read"),
    decode: () => [] as const,
    action: () => null,
    encode: () => {
      throw new InternalError("encode failed");
    },
  });
  const out = await collect(
    dispatchWs(fakeRig, [r], frame("read"), new AbortController()),
  );
  assertEquals(out, [{ id: "f1", success: false, error: "encode failed" }]);
});

Deno.test("dispatchWs: non-Error thrown value stringifies into envelope", async () => {
  const r = route({
    on: wsData("status"),
    decode: () => [] as const,
    action: () => {
      throw "nope";
    },
    encode: () => ({ id: "x", success: true }),
  });
  const out = await collect(
    dispatchWs(fakeRig, [r], frame("status"), new AbortController()),
  );
  assertEquals(out, [{ id: "f1", success: false, error: "nope" }]);
});

// ── dispatchWs: encode result shapes ──

Deno.test("dispatchWs: encode returning undefined → no envelope (fire-and-forget)", async () => {
  const r = route({
    on: wsData("observe-cancel"),
    decode: () => [] as const,
    action: () => null,
    encode: () => undefined,
  });
  const out = await collect(
    dispatchWs(fakeRig, [r], frame("observe-cancel"), new AbortController()),
  );
  assertEquals(out, []);
});

Deno.test("dispatchWs: encode returning a single envelope yields once", async () => {
  const r = route({
    on: wsData("status"),
    decode: () => [] as const,
    action: () => ({ status: "healthy" }),
    encode: (data, { id }) => ({ id, success: true, data }),
  });
  const out = await collect(
    dispatchWs(fakeRig, [r], frame("status"), new AbortController()),
  );
  assertEquals(out, [
    { id: "f1", success: true, data: { status: "healthy" } },
  ]);
});

Deno.test("dispatchWs: encode returning AsyncIterable yields each frame", async () => {
  async function* stream(): AsyncIterable<WebSocketResponse> {
    yield { id: "f1", success: true, data: ["a"] };
    yield { id: "f1", success: true, data: ["b"] };
    yield { id: "f1", success: true, data: null };
  }
  const r = route({
    on: wsData("observe"),
    decode: () => [] as const,
    action: () => null,
    encode: () => stream(),
  });
  const out = await collect(
    dispatchWs(fakeRig, [r], frame("observe"), new AbortController()),
  );
  assertEquals(out, [
    { id: "f1", success: true, data: ["a"] },
    { id: "f1", success: true, data: ["b"] },
    { id: "f1", success: true, data: null },
  ]);
});

// ── dispatchWs: termination ──

Deno.test("dispatchWs: terminates after first matching route (does not fall through)", async () => {
  let secondInvoked = false;
  const first = route({
    on: wsData("receive"),
    decode: () => [] as const,
    action: () => null,
    encode: (_d, { id }) => ({ id, success: true, data: 1 }),
  });
  const second = route({
    on: wsData("receive"),
    decode: () => {
      secondInvoked = true;
      return [] as const;
    },
    action: () => null,
    encode: (_d, { id }) => ({ id, success: true, data: 2 }),
  });
  await collect(
    dispatchWs(
      fakeRig,
      [first, second],
      frame("receive"),
      new AbortController(),
    ),
  );
  assertEquals(secondInvoked, false);
});
