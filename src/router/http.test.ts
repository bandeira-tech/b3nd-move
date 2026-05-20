/// <reference lib="deno.ns" />
/**
 * dispatchHttp: declarative match, path params, method gating,
 * 404 / 405 fallbacks.
 */

import { assertEquals } from "@std/assert";
import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { dispatchHttp, type HttpRoute } from "./http.ts";

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
  const route = connection(new StubBackend(), ["*"]);
  return new Rig({ routes: { receive: [route], read: [route] } });
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://test${path}`, init);
}

const hit: HttpRoute["respond"] = () => new Response("hit", { status: 200 });

Deno.test("dispatchHttp: empty route list → 404", async () => {
  const r = await dispatchHttp(buildRig(), [], req("/anything"));
  assertEquals(r.status, 404);
});

Deno.test("dispatchHttp: path matches, method matches → build → respond", async () => {
  const route: HttpRoute = {
    on: { method: "GET", path: "/api/v1/status" },
    build: () => ({ action: "status" }),
    respond: hit,
  };
  const r = await dispatchHttp(buildRig(), [route], req("/api/v1/status"));
  assertEquals(r.status, 200);
  assertEquals(await r.text(), "hit");
});

Deno.test("dispatchHttp: no matching path → 404", async () => {
  const route: HttpRoute = {
    on: { method: "GET", path: "/api/v1/status" },
    build: () => ({ action: "status" }),
    respond: hit,
  };
  const r = await dispatchHttp(buildRig(), [route], req("/elsewhere"));
  assertEquals(r.status, 404);
});

Deno.test("dispatchHttp: path matches but method doesn't → 405 with Allow", async () => {
  const route: HttpRoute = {
    on: { method: "GET", path: "/api/v1/status" },
    build: () => ({ action: "status" }),
    respond: hit,
  };
  const r = await dispatchHttp(
    buildRig(),
    [route],
    req("/api/v1/status", { method: "POST" }),
  );
  assertEquals(r.status, 405);
  assertEquals(r.headers.get("Allow"), "GET");
});

Deno.test("dispatchHttp: 405 Allow unions methods from all path-matching routes", async () => {
  const get: HttpRoute = {
    on: { method: "GET", path: "/api/v1/content/:uri" },
    build: () => ({ action: "status" }),
    respond: hit,
  };
  const post: HttpRoute = {
    on: { method: "POST", path: "/api/v1/content/:uri" },
    build: () => ({ action: "status" }),
    respond: hit,
  };
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
  const route: HttpRoute = {
    on: { method: "GET", path: "/api/v1/content/:uri" },
    build: (_req, params) => {
      seen = params;
      return { action: "status" };
    },
    respond: hit,
  };
  await dispatchHttp(buildRig(), [route], req("/api/v1/content/abc%2Fdef"));
  assertEquals(seen, { uri: "abc%2Fdef" });
});

Deno.test("dispatchHttp: trailing slash does not match :param (strict)", async () => {
  const route: HttpRoute = {
    on: { method: "GET", path: "/api/v1/content/:uri" },
    build: () => ({ action: "status" }),
    respond: hit,
  };
  const r = await dispatchHttp(buildRig(), [route], req("/api/v1/content/"));
  assertEquals(r.status, 404);
});

Deno.test("dispatchHttp: multi-method matcher accepts both", async () => {
  const route: HttpRoute = {
    on: { method: ["GET", "POST"], path: "/api/v1/x" },
    build: () => ({ action: "status" }),
    respond: hit,
  };
  const a = await dispatchHttp(buildRig(), [route], req("/api/v1/x"));
  const b = await dispatchHttp(
    buildRig(),
    [route],
    req("/api/v1/x", { method: "POST" }),
  );
  assertEquals(a.status, 200);
  assertEquals(b.status, 200);
});

Deno.test("dispatchHttp: build returning Response short-circuits", async () => {
  const route: HttpRoute = {
    on: { method: "GET", path: "/api/v1/x" },
    build: () => new Response("bad", { status: 400 }),
    respond: hit,
  };
  const r = await dispatchHttp(buildRig(), [route], req("/api/v1/x"));
  assertEquals(r.status, 400);
  assertEquals(await r.text(), "bad");
});

Deno.test("dispatchHttp: first matching route wins", async () => {
  const first: HttpRoute = {
    on: { method: "GET", path: "/api/v1/x" },
    build: () => ({ action: "status" }),
    respond: () => new Response("first", { status: 200 }),
  };
  const second: HttpRoute = {
    on: { method: "GET", path: "/api/v1/x" },
    build: () => ({ action: "status" }),
    respond: () => new Response("second", { status: 200 }),
  };
  const r = await dispatchHttp(buildRig(), [first, second], req("/api/v1/x"));
  assertEquals(await r.text(), "first");
});

Deno.test("dispatchHttp: literal segment mismatch → no match", async () => {
  const route: HttpRoute = {
    on: { method: "GET", path: "/api/v1/x" },
    build: () => ({ action: "status" }),
    respond: hit,
  };
  const r = await dispatchHttp(buildRig(), [route], req("/api/v1/y"));
  assertEquals(r.status, 404);
});
