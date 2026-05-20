/// <reference lib="deno.ns" />
/**
 * dispatchHttp: route walking, short-circuit, ordering, no-match.
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

Deno.test("dispatchHttp: empty route list → 404", async () => {
  const r = await dispatchHttp(buildRig(), [], req("/anything"));
  assertEquals(r.status, 404);
});

Deno.test("dispatchHttp: no match → 404", async () => {
  const route: HttpRoute = {
    matches: () => false,
    build: () => Promise.resolve({ action: "status" }),
    respond: () => Promise.resolve(new Response("never", { status: 200 })),
  };
  const r = await dispatchHttp(buildRig(), [route], req("/anything"));
  assertEquals(r.status, 404);
});

Deno.test("dispatchHttp: matched route runs build → respond", async () => {
  const route: HttpRoute = {
    matches: (req) => req.method === "GET" && req.url.endsWith("/x"),
    build: () => Promise.resolve({ action: "status" }),
    respond: () => Promise.resolve(new Response("hit", { status: 200 })),
  };
  const r = await dispatchHttp(buildRig(), [route], req("/x"));
  assertEquals(r.status, 200);
  assertEquals(await r.text(), "hit");
});

Deno.test("dispatchHttp: build returning Response short-circuits", async () => {
  const route: HttpRoute = {
    matches: () => true,
    build: () => Promise.resolve(new Response("bad", { status: 400 })),
    respond: () => Promise.resolve(new Response("never", { status: 200 })),
  };
  const r = await dispatchHttp(buildRig(), [route], req("/x"));
  assertEquals(r.status, 400);
  assertEquals(await r.text(), "bad");
});

Deno.test("dispatchHttp: first matching route wins", async () => {
  const first: HttpRoute = {
    matches: () => true,
    build: () => Promise.resolve({ action: "status" }),
    respond: () => Promise.resolve(new Response("first", { status: 200 })),
  };
  const second: HttpRoute = {
    matches: () => true,
    build: () => Promise.resolve({ action: "status" }),
    respond: () => Promise.resolve(new Response("second", { status: 200 })),
  };
  const r = await dispatchHttp(buildRig(), [first, second], req("/x"));
  assertEquals(await r.text(), "first");
});

Deno.test("dispatchHttp: respond receives the call build produced", async () => {
  let seen: unknown = null;
  const route: HttpRoute = {
    matches: () => true,
    build: () => Promise.resolve({ action: "read", urls: ["mutable://t/x"] }),
    respond: (_rig, _req, call) => {
      seen = call;
      return Promise.resolve(new Response("ok"));
    },
  };
  await dispatchHttp(buildRig(), [route], req("/x"));
  assertEquals(seen, { action: "read", urls: ["mutable://t/x"] });
});
