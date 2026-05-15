/**
 * `preSend` — verify each client's hook reaches the wire.
 *
 * No framework, no canon: the hook is just a function. These tests
 * exercise the simplest "stamp an auth header / mutate the envelope"
 * cases plus the WS `url: () => ...` form for handshake-time tokens.
 */

/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import { HttpClient } from "../../../src/http/client.ts";
import { GrpcHttpClient } from "../../../src/grpc/http/client.ts";
import { WebSocketClient } from "../../../src/ws/client.ts";
import { startGrpcServer } from "../../factories/grpc.ts";
import { startWsServer } from "../../factories/ws.ts";
import { memoryRig } from "../../rigs/memory.ts";

Deno.test("HttpClient preSend — stamps headers and query params on every call", async () => {
  const seen: { auth?: string | null; trace?: string | null; region?: string | null }[] = [];
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    (req) => {
      const url = new URL(req.url);
      seen.push({
        auth: req.headers.get("Authorization"),
        trace: req.headers.get("X-Trace"),
        region: url.searchParams.get("region"),
      });
      return new Response(JSON.stringify([]), {
        headers: { "Content-Type": "application/json" },
      });
    },
  );

  try {
    const port = (server.addr as Deno.NetAddr).port;
    const client = new HttpClient({
      url: `http://127.0.0.1:${port}`,
      preSend: (r) => {
        r.headers.set("Authorization", "Bearer tok-1");
        r.headers.set("X-Trace", "t-1");
        r.url.searchParams.set("region", "eu");
      },
    });
    await client.receive([["mutable://x/y", { v: 1 }]]);
    await client.receive([["mutable://x/z", { v: 2 }]]);
    assertEquals(seen.length, 2);
    for (const s of seen) {
      assertEquals(s.auth, "Bearer tok-1");
      assertEquals(s.trace, "t-1");
      assertEquals(s.region, "eu");
    }
  } finally {
    ac.abort();
    await server.finished;
  }
});

Deno.test("HttpClient preSend — async hook is awaited", async () => {
  const ac = new AbortController();
  let receivedAuth: string | null = null;
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    (req) => {
      receivedAuth = req.headers.get("Authorization");
      return new Response(JSON.stringify([]), {
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  try {
    const port = (server.addr as Deno.NetAddr).port;
    const client = new HttpClient({
      url: `http://127.0.0.1:${port}`,
      preSend: async (r) => {
        await Promise.resolve();
        r.headers.set("Authorization", "Bearer async-tok");
      },
    });
    await client.receive([["mutable://x/y", {}]]);
    assertEquals(receivedAuth, "Bearer async-tok");
  } finally {
    ac.abort();
    await server.finished;
  }
});

Deno.test("HttpClient preSend — functions compose via plain calls", async () => {
  const ac = new AbortController();
  let seenAuth: string | null = null;
  let seenTrace: string | null = null;
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    (req) => {
      seenAuth = req.headers.get("Authorization");
      seenTrace = req.headers.get("X-Trace");
      return new Response(JSON.stringify([]), {
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  try {
    const port = (server.addr as Deno.NetAddr).port;
    type Req = { headers: Headers };
    const auth = (r: Req) => r.headers.set("Authorization", "Bearer t");
    const trace = (r: Req) => r.headers.set("X-Trace", "tr");
    const client = new HttpClient({
      url: `http://127.0.0.1:${port}`,
      preSend: (r) => {
        auth(r);
        trace(r);
      },
    });
    await client.receive([["mutable://x/y", {}]]);
    assertEquals(seenAuth, "Bearer t");
    assertEquals(seenTrace, "tr");
  } finally {
    ac.abort();
    await server.finished;
  }
});

Deno.test("GrpcHttpClient preSend — stamps headers on rpc", async () => {
  const server = await startGrpcServer(memoryRig());
  let seenAuth: string | null = null;
  // Wrap by routing through the actual client; we sniff via a separate
  // listener proxy. Simpler: re-use the real server but stamp on
  // outbound and verify by round-trip success — there's no read-back
  // here for headers without a custom listener. Instead, run a tiny
  // sniffer.
  await server.stop();

  const ac = new AbortController();
  const sniffer = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    (req) => {
      seenAuth = req.headers.get("Authorization");
      return new Response(JSON.stringify({ results: [] }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  try {
    const port = (sniffer.addr as Deno.NetAddr).port;
    const client = new GrpcHttpClient({
      url: `http://127.0.0.1:${port}`,
      preSend: (r) => r.headers.set("Authorization", "Bearer g-1"),
    });
    await client.receive([["mutable://g/h", { v: 1 }]]);
    assertEquals(seenAuth, "Bearer g-1");
  } finally {
    ac.abort();
    await sniffer.finished;
  }
});

Deno.test("WebSocketClient preSend — mutates outbound envelope per frame", async () => {
  const server = await startWsServer(memoryRig());
  try {
    let count = 0;
    const client = new WebSocketClient({
      url: server.url,
      reconnect: { enabled: false },
      preSend: (env) => {
        env.stamp = `frame-${count++}`;
      },
    });
    // Round-trip succeeds — the server ignores the extra `stamp` field
    // but the hook still ran. We confirm by counting invocations.
    await client.status();
    await client.receive([["mutable://w/x", { v: 1 }]]);
    // status + receive both call sendRequest → preSend twice.
    assertEquals(count, 2);
  } finally {
    await server.stop();
  }
});

Deno.test("WebSocketClient — url accepts a function for handshake-time token", async () => {
  const server = await startWsServer(memoryRig());
  try {
    let calls = 0;
    const client = new WebSocketClient({
      url: () => {
        calls++;
        // The server here doesn't read query params, but the URL is
        // resolved on each connect — that's what we assert.
        return `${server.url}?token=t-${calls}`;
      },
      reconnect: { enabled: false },
    });
    await client.status();
    assertEquals(calls, 1);
  } finally {
    await server.stop();
  }
});
