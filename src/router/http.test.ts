/// <reference lib="deno.ns" />
/**
 * dispatchHttp: declarative match, path params, method gating,
 * action execution, 404 / 405 fallbacks.
 */

import { assertEquals } from "@std/assert";
import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { BadRequest, InternalError, NotFound } from "./errors.ts";
import { dispatchHttp, route } from "./http.ts";
import type { Route } from "./route.ts";

class StubBackend implements ProtocolInterfaceNode {
  receive(outs: Output[]): Promise<ReceiveResult[]> {
    return Promise.resolve(outs.map(() => ({ accepted: true })));
  }
  read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
    return Promise.resolve(
      urls.map((u): Output<T> => [u, { echo: u } as unknown as T]),
    );
  }
  // deno-lint-ignore require-yield
  async *observe(): AsyncIterable<readonly string[]> {
    return;
  }
  status(): Promise<StatusResult> {
    return Promise.resolve({ status: "healthy" });
  }
}

function buildRig(): Rig {
  const r = connection(new StubBackend(), ["*"]);
  return new Rig({ routes: { receive: [r], read: [r] } });
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://test${path}`, init);
}

const statusRoute = (): Route =>
  route({
    on: { method: "GET", path: "/api/v1/x" },
    action: "status",
    decode: () => [],
    encode: () => new Response("hit", { status: 200 }),
  });

Deno.test("dispatchHttp: empty route list → 404", async () => {
  const r = await dispatchHttp(buildRig(), [], req("/anything"));
  assertEquals(r.status, 404);
});

Deno.test("dispatchHttp: path + method match → decode → action → encode", async () => {
  const r = await dispatchHttp(buildRig(), [statusRoute()], req("/api/v1/x"));
  assertEquals(r.status, 200);
  assertEquals(await r.text(), "hit");
});

Deno.test("dispatchHttp: no matching path → 404", async () => {
  const r = await dispatchHttp(buildRig(), [statusRoute()], req("/elsewhere"));
  assertEquals(r.status, 404);
});

Deno.test("dispatchHttp: path matches but method doesn't → 405 with Allow", async () => {
  const r = await dispatchHttp(
    buildRig(),
    [statusRoute()],
    req("/api/v1/x", { method: "POST" }),
  );
  assertEquals(r.status, 405);
  assertEquals(r.headers.get("Allow"), "GET");
});

Deno.test("dispatchHttp: 405 Allow unions methods from all path-matching routes", async () => {
  const get = route({
    on: { method: "GET", path: "/api/v1/content/:uri" },
    action: "status",
    decode: () => [],
    encode: () => new Response("get"),
  });
  const post = route({
    on: { method: "POST", path: "/api/v1/content/:uri" },
    action: "status",
    decode: () => [],
    encode: () => new Response("post"),
  });
  const r = await dispatchHttp(
    buildRig(),
    [get, post],
    req("/api/v1/content/x", { method: "PUT" }),
  );
  assertEquals(r.status, 405);
  const allow = (r.headers.get("Allow") ?? "").split(", ").sort();
  assertEquals(allow, ["GET", "POST"]);
});

Deno.test("dispatchHttp: :param captures into params", async () => {
  let seen: Record<string, string> | null = null;
  const r = route({
    on: { method: "GET", path: "/api/v1/content/:uri" },
    action: "status",
    decode: ({ params }) => {
      seen = params;
      return [];
    },
    encode: () => new Response("ok"),
  });
  await dispatchHttp(buildRig(), [r], req("/api/v1/content/abc%2Fdef"));
  assertEquals(seen, { uri: "abc%2Fdef" });
});

Deno.test("dispatchHttp: trailing slash does not match :param (strict)", async () => {
  const r = route({
    on: { method: "GET", path: "/api/v1/content/:uri" },
    action: "status",
    decode: () => [],
    encode: () => new Response("ok"),
  });
  const res = await dispatchHttp(buildRig(), [r], req("/api/v1/content/"));
  assertEquals(res.status, 404);
});

Deno.test("dispatchHttp: multi-method matcher accepts both", async () => {
  const r = route({
    on: { method: ["GET", "POST"], path: "/api/v1/x" },
    action: "status",
    decode: () => [],
    encode: () => new Response("ok"),
  });
  const a = await dispatchHttp(buildRig(), [r], req("/api/v1/x"));
  const b = await dispatchHttp(
    buildRig(),
    [r],
    req("/api/v1/x", { method: "POST" }),
  );
  assertEquals(a.status, 200);
  assertEquals(b.status, 200);
});

Deno.test("dispatchHttp: decode throwing BadRequest → 400 + plain text", async () => {
  const r = route({
    on: { method: "GET", path: "/api/v1/x" },
    action: "status",
    decode: () => {
      throw new BadRequest("nope");
    },
    encode: () => new Response("never"),
  });
  const res = await dispatchHttp(buildRig(), [r], req("/api/v1/x"));
  assertEquals(res.status, 400);
  assertEquals(await res.text(), "nope");
});

Deno.test("dispatchHttp: encode throwing NotFound → 404 + plain text", async () => {
  const r = route({
    on: { method: "GET", path: "/api/v1/x" },
    action: "status",
    decode: () => [],
    encode: () => {
      throw new NotFound("gone");
    },
  });
  const res = await dispatchHttp(buildRig(), [r], req("/api/v1/x"));
  assertEquals(res.status, 404);
  assertEquals(await res.text(), "gone");
});

Deno.test("dispatchHttp: arbitrary thrown error → 500 + message", async () => {
  const r = route({
    on: { method: "GET", path: "/api/v1/x" },
    action: "status",
    decode: () => {
      throw new Error("kaboom");
    },
    encode: () => new Response("never"),
  });
  const res = await dispatchHttp(buildRig(), [r], req("/api/v1/x"));
  assertEquals(res.status, 500);
  assertEquals(await res.text(), "kaboom");
});

Deno.test("dispatchHttp: InternalError thrown explicitly → 500 + message", async () => {
  const r = route({
    on: { method: "GET", path: "/api/v1/x" },
    action: "status",
    decode: () => {
      throw new InternalError("hook misbehaved");
    },
    encode: () => new Response("never"),
  });
  const res = await dispatchHttp(buildRig(), [r], req("/api/v1/x"));
  assertEquals(res.status, 500);
  assertEquals(await res.text(), "hook misbehaved");
});

Deno.test("dispatchHttp: encode receives unwrapped rig result", async () => {
  const seen: { result?: StatusResult } = {};
  const r = route({
    on: { method: "GET", path: "/api/v1/x" },
    action: "status",
    decode: () => [],
    encode: (result) => {
      seen.result = result;
      return new Response("ok");
    },
  });
  await dispatchHttp(buildRig(), [r], req("/api/v1/x"));
  assertEquals(seen.result?.status, "healthy");
});

Deno.test("dispatchHttp: encode for observe receives the AsyncIterable", async () => {
  let kind = "";
  const r = route({
    on: { method: "POST", path: "/api/v1/x" },
    action: "observe",
    decode: () => [["mutable://t/p"]] as const,
    encode: (result) => {
      kind = Symbol.asyncIterator in (result as object) ? "iterable" : "other";
      return new Response("ok");
    },
  });
  await dispatchHttp(buildRig(), [r], req("/api/v1/x", { method: "POST" }));
  assertEquals(kind, "iterable");
});

Deno.test("dispatchHttp: first matching route wins", async () => {
  const first = route({
    on: { method: "GET", path: "/api/v1/x" },
    action: "status",
    decode: () => [],
    encode: () => new Response("first"),
  });
  const second = route({
    on: { method: "GET", path: "/api/v1/x" },
    action: "status",
    decode: () => [],
    encode: () => new Response("second"),
  });
  const r = await dispatchHttp(buildRig(), [first, second], req("/api/v1/x"));
  assertEquals(await r.text(), "first");
});

Deno.test("dispatchHttp: literal segment mismatch → no match", async () => {
  const res = await dispatchHttp(
    buildRig(),
    [statusRoute()],
    req("/api/v1/y"),
  );
  assertEquals(res.status, 404);
});
