/**
 * Middleware — unit tests for the canon helpers and run hooks.
 * Also covers end-to-end propagation through `HttpClient` against a
 * real `Deno.serve` listener so we know mutations from middleware
 * actually reach the wire.
 */

/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import {
  apiKey,
  basic,
  bearer,
  type ClientMiddleware,
  type ConnectContext,
  header,
  query,
  type RequestContext,
  runConnect,
  runRequest,
  runSend,
  signEnvelope,
  subprotocol,
} from "../../../src/middleware.ts";
import { HttpClient } from "../../../src/http/client.ts";

function reqCtx(): RequestContext {
  return {
    transport: "http",
    url: new URL("https://example.test/api"),
    headers: new Headers(),
    body: null,
  };
}

function connectCtx(): ConnectContext {
  return {
    transport: "ws",
    url: new URL("ws://example.test/ws"),
    subprotocols: [],
  };
}

Deno.test("bearer — sets Authorization on HTTP, query on WS handshake", async () => {
  const mw = bearer("tok-123");

  const req = reqCtx();
  await runRequest([mw], req);
  assertEquals(req.headers.get("Authorization"), "Bearer tok-123");

  const conn = connectCtx();
  await runConnect([mw], conn);
  assertEquals(conn.url.searchParams.get("token"), "tok-123");
});

Deno.test("bearer — accepts async getter", async () => {
  const mw = bearer(async () => {
    await Promise.resolve();
    return "rotated";
  });
  const req = reqCtx();
  await runRequest([mw], req);
  assertEquals(req.headers.get("Authorization"), "Bearer rotated");
});

Deno.test("basic — base64 header on HTTP, user/pass on WS URL", async () => {
  const mw = basic("alice", "wonderland");

  const req = reqCtx();
  await runRequest([mw], req);
  assertEquals(
    req.headers.get("Authorization"),
    `Basic ${btoa("alice:wonderland")}`,
  );

  const conn = connectCtx();
  await runConnect([mw], conn);
  assertEquals(conn.url.username, "alice");
  assertEquals(conn.url.password, "wonderland");
});

Deno.test("header — sets arbitrary header on HTTP only", async () => {
  const mw = header("X-Trace", "abc");
  const req = reqCtx();
  await runRequest([mw], req);
  assertEquals(req.headers.get("X-Trace"), "abc");

  // WS handshake: no-op
  const conn = connectCtx();
  await runConnect([mw], conn);
  assertEquals(conn.url.searchParams.toString(), "");
});

Deno.test("query — sets URL param on both HTTP and WS", async () => {
  const mw = query("region", "us-east");

  const req = reqCtx();
  await runRequest([mw], req);
  assertEquals(req.url.searchParams.get("region"), "us-east");

  const conn = connectCtx();
  await runConnect([mw], conn);
  assertEquals(conn.url.searchParams.get("region"), "us-east");
});

Deno.test("subprotocol — pushes onto WS handshake subprotocols", async () => {
  const mw = subprotocol("b3nd.bearer.tok-9");
  const conn = connectCtx();
  await runConnect([mw], conn);
  assertEquals(conn.subprotocols, ["b3nd.bearer.tok-9"]);
});

Deno.test("apiKey — header form (default)", async () => {
  const mw = apiKey("k-1");
  const req = reqCtx();
  await runRequest([mw], req);
  assertEquals(req.headers.get("X-API-Key"), "k-1");
});

Deno.test("apiKey — query form", async () => {
  const mw = apiKey("k-1", { in: "query", name: "key" });
  const req = reqCtx();
  await runRequest([mw], req);
  assertEquals(req.url.searchParams.get("key"), "k-1");
});

Deno.test("signEnvelope — mutates WS frame in place", async () => {
  const mw = signEnvelope((env) => {
    env.sig = "deadbeef";
    env.nonce = 42;
  });
  const envelope: Record<string, unknown> = { id: "x", type: "receive" };
  await runSend([mw], { transport: "ws", envelope });
  assertEquals(envelope.sig, "deadbeef");
  assertEquals(envelope.nonce, 42);
});

Deno.test("middleware chain runs in order", async () => {
  const order: string[] = [];
  const a: ClientMiddleware = {
    onRequest: () => {
      order.push("a");
    },
  };
  const b: ClientMiddleware = {
    onRequest: async () => {
      await Promise.resolve();
      order.push("b");
    },
  };
  const c: ClientMiddleware = {
    onRequest: () => {
      order.push("c");
    },
  };
  await runRequest([a, b, c], reqCtx());
  assertEquals(order, ["a", "b", "c"]);
});

Deno.test("HttpClient — middleware reaches the wire", async () => {
  const seen: Record<string, string | null> = {};
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    (req) => {
      seen.auth = req.headers.get("Authorization");
      seen.trace = req.headers.get("X-Trace");
      const url = new URL(req.url);
      seen.region = url.searchParams.get("region");
      return new Response(JSON.stringify([]), {
        headers: { "Content-Type": "application/json" },
      });
    },
  );

  try {
    const port = (server.addr as Deno.NetAddr).port;
    const client = new HttpClient({
      url: `http://127.0.0.1:${port}`,
      middleware: [
        bearer("abc"),
        header("X-Trace", "trace-1"),
        query("region", "eu-west"),
      ],
    });
    await client.receive([["mutable://x/y", { v: 1 }]]);
    assertEquals(seen.auth, "Bearer abc");
    assertEquals(seen.trace, "trace-1");
    assertEquals(seen.region, "eu-west");
  } finally {
    ac.abort();
    await server.finished;
  }
});
