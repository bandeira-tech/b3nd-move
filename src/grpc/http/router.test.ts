/// <reference lib="deno.ns" />
/**
 * dispatchGrpc + grpcMethod + detectEncoding: matcher dispatch, error
 * rendering as `{ error }` JSON, 204, 404 (non-POST / missing prefix /
 * unknown method), encoding negotiation.
 *
 * Pure unit — no rig, no server. `rig` is a typed-cast stub the routes
 * never touch; every route supplies its own action.
 */

import { assertEquals } from "@std/assert";
import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import { BadRequest, InternalError, NotFound } from "../../router/errors.ts";
import {
  detectEncoding,
  dispatchGrpc,
  grpcMethod,
  route,
  SERVICE_PREFIX,
} from "./router.ts";

const fakeRig = {} as Rig;

function rpc(
  method: string,
  init?: RequestInit & { url?: string },
): Request {
  return new Request(
    init?.url ?? `http://test${SERVICE_PREFIX}${method}`,
    { method: "POST", ...init },
  );
}

async function asJson(res: Response): Promise<unknown> {
  return JSON.parse(await res.text());
}

// ── detectEncoding ──

Deno.test("detectEncoding: connect+proto / proto / grpc → binary", () => {
  for (const ct of [
    "application/connect+proto",
    "application/proto",
    "application/grpc",
    "application/grpc-web+proto",
  ]) {
    const r = new Request("http://x", { headers: { "Content-Type": ct } });
    assertEquals(detectEncoding(r), "binary", `${ct} should be binary`);
  }
});

Deno.test("detectEncoding: anything else (including missing CT) → json", () => {
  for (const ct of ["application/json", "application/connect+json", "text/plain", ""]) {
    const r = new Request("http://x", { headers: { "Content-Type": ct } });
    assertEquals(detectEncoding(r), "json", `${ct} should be json`);
  }
  assertEquals(detectEncoding(new Request("http://x")), "json");
});

// ── grpcMethod (matcher generator) ──

Deno.test("grpcMethod: matches the full SERVICE_PREFIX + method path", () => {
  const m = grpcMethod("Receive");
  assertEquals(m(rpc("Receive")), true);
  assertEquals(m(rpc("Read")), null);
  assertEquals(
    m(new Request(`http://test${SERVICE_PREFIX}Receive/extra`, { method: "POST" })),
    null,
  );
});

// ── dispatchGrpc: upstream gate ──

Deno.test("dispatchGrpc: non-POST → 404 plain text (does not walk routes)", async () => {
  let walked = false;
  const r = route({
    on: () => {
      walked = true;
      return true;
    },
    decode: () => [] as const,
    action: () => null,
    encode: () => new Response("ok"),
  });
  const res = await dispatchGrpc(
    fakeRig,
    [r],
    new Request(`http://test${SERVICE_PREFIX}Receive`, { method: "GET" }),
  );
  assertEquals(res.status, 404);
  assertEquals(await res.text(), "Not Found");
  assertEquals(walked, false);
});

Deno.test("dispatchGrpc: missing SERVICE_PREFIX → 404 plain text", async () => {
  const res = await dispatchGrpc(
    fakeRig,
    [],
    new Request("http://test/other/Receive", { method: "POST" }),
  );
  assertEquals(res.status, 404);
  assertEquals(await res.text(), "Not Found");
});

// ── dispatchGrpc: matching ──

Deno.test("dispatchGrpc: no matching route → 404 JSON with unknown method", async () => {
  const res = await dispatchGrpc(fakeRig, [], rpc("Unknown"));
  assertEquals(res.status, 404);
  assertEquals(await asJson(res), { error: "Unknown method: Unknown" });
});

Deno.test("dispatchGrpc: first matching route wins", async () => {
  const first = route({
    on: grpcMethod("Receive"),
    decode: () => [] as const,
    action: () => "first",
    encode: (data) => new Response(JSON.stringify({ data })),
  });
  const second = route({
    on: grpcMethod("Receive"),
    decode: () => [] as const,
    action: () => "second",
    encode: (data) => new Response(JSON.stringify({ data })),
  });
  const res = await dispatchGrpc(fakeRig, [first, second], rpc("Receive"));
  assertEquals(await asJson(res), { data: "first" });
});

Deno.test("dispatchGrpc: custom matcher (not grpcMethod) participates", async () => {
  const r = route({
    on: (req) => req.headers.get("x-magic") === "yes" ? true : null,
    decode: () => [] as const,
    action: () => "hit",
    encode: (d) => new Response(JSON.stringify({ d })),
  });
  const hit = await dispatchGrpc(
    fakeRig,
    [r],
    rpc("Anything", { headers: { "x-magic": "yes" } }),
  );
  assertEquals(await asJson(hit), { d: "hit" });

  const miss = await dispatchGrpc(fakeRig, [r], rpc("Anything"));
  assertEquals(miss.status, 404);
});

// ── dispatchGrpc: ctx wiring ──

Deno.test("dispatchGrpc: ctx exposes req, encoding, abort", async () => {
  let seen: { encoding?: string; reqIsRequest?: boolean; aborted?: boolean } = {};
  const r = route({
    on: grpcMethod("Status"),
    decode: ({ req, encoding, abort }) => {
      seen = {
        encoding,
        reqIsRequest: req instanceof Request,
        aborted: abort.signal.aborted,
      };
      return [] as const;
    },
    action: () => null,
    encode: () => new Response(null, { status: 200 }),
  });
  await dispatchGrpc(
    fakeRig,
    [r],
    rpc("Status", { headers: { "Content-Type": "application/proto" } }),
  );
  assertEquals(seen, { encoding: "binary", reqIsRequest: true, aborted: false });
});

Deno.test("dispatchGrpc: encoding defaults to json when CT absent", async () => {
  let encoding: string | undefined;
  const r = route({
    on: grpcMethod("Status"),
    decode: (ctx) => {
      encoding = ctx.encoding;
      return [] as const;
    },
    action: () => null,
    encode: () => new Response("ok"),
  });
  await dispatchGrpc(fakeRig, [r], rpc("Status"));
  assertEquals(encoding, "json");
});

Deno.test("dispatchGrpc: action receives the same abort signal as ctx", async () => {
  let actionSignal: AbortSignal | null = null;
  let ctxSignal: AbortSignal | null = null;
  const r = route({
    on: grpcMethod("Status"),
    decode: ({ abort }) => {
      ctxSignal = abort.signal;
      return [] as const;
    },
    action: (_rig, _args, signal) => {
      actionSignal = signal;
      return null;
    },
    encode: () => new Response("ok"),
  });
  await dispatchGrpc(fakeRig, [r], rpc("Status"));
  assertEquals(actionSignal, ctxSignal);
});

// ── dispatchGrpc: error rendering ──

Deno.test("dispatchGrpc: decode throwing BadRequest → status from error + JSON envelope", async () => {
  const r = route({
    on: grpcMethod("Receive"),
    decode: () => {
      throw new BadRequest("bad");
    },
    action: () => null,
    encode: () => new Response("ok"),
  });
  const res = await dispatchGrpc(fakeRig, [r], rpc("Receive"));
  assertEquals(res.status, 400);
  assertEquals(res.headers.get("Content-Type"), "application/json");
  assertEquals(await asJson(res), { error: "bad" });
});

Deno.test("dispatchGrpc: encode throwing NotFound → 404 JSON envelope", async () => {
  const r = route({
    on: grpcMethod("Read"),
    decode: () => [] as const,
    action: () => null,
    encode: () => {
      throw new NotFound("gone");
    },
  });
  const res = await dispatchGrpc(fakeRig, [r], rpc("Read"));
  assertEquals(res.status, 404);
  assertEquals(await asJson(res), { error: "gone" });
});

Deno.test("dispatchGrpc: arbitrary Error → 500 JSON envelope", async () => {
  const r = route({
    on: grpcMethod("Read"),
    decode: () => [] as const,
    action: () => {
      throw new Error("kaboom");
    },
    encode: () => new Response("ok"),
  });
  const res = await dispatchGrpc(fakeRig, [r], rpc("Read"));
  assertEquals(res.status, 500);
  assertEquals(await asJson(res), { error: "kaboom" });
});

Deno.test("dispatchGrpc: InternalError thrown explicitly → 500 JSON envelope", async () => {
  const r = route({
    on: grpcMethod("Receive"),
    decode: () => {
      throw new InternalError("internal");
    },
    action: () => null,
    encode: () => new Response("ok"),
  });
  const res = await dispatchGrpc(fakeRig, [r], rpc("Receive"));
  assertEquals(res.status, 500);
  assertEquals(await asJson(res), { error: "internal" });
});

Deno.test("dispatchGrpc: non-Error thrown value stringifies into JSON", async () => {
  const r = route({
    on: grpcMethod("Receive"),
    decode: () => {
      throw "nope";
    },
    action: () => null,
    encode: () => new Response("ok"),
  });
  const res = await dispatchGrpc(fakeRig, [r], rpc("Receive"));
  assertEquals(await asJson(res), { error: "nope" });
});

// ── dispatchGrpc: encode result shapes ──

Deno.test("dispatchGrpc: encode returning undefined → 204 No Content", async () => {
  const r = route({
    on: grpcMethod("Receive"),
    decode: () => [] as const,
    action: () => null,
    encode: () => undefined,
  });
  const res = await dispatchGrpc(fakeRig, [r], rpc("Receive"));
  assertEquals(res.status, 204);
  assertEquals(await res.text(), "");
});

Deno.test("dispatchGrpc: encode result flows through unchanged", async () => {
  const r = route({
    on: grpcMethod("Status"),
    decode: () => [] as const,
    action: () => ({ status: "healthy" }),
    encode: (data) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });
  const res = await dispatchGrpc(fakeRig, [r], rpc("Status"));
  assertEquals(res.status, 200);
  assertEquals(await asJson(res), { status: "healthy" });
});
