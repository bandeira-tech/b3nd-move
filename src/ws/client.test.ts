/// <reference lib="deno.ns" />
/**
 * WebSocketClient: pure unit tests with `globalThis.WebSocket` stubbed.
 *
 * Documents the unary RPC surface (receive / read / status) — envelope
 * shape, response routing by id, error mapping, preSend hook. observe
 * streaming has its own file (`./observe.test.ts`).
 *
 * The mock tracks sent frames and exposes hooks to push messages, close,
 * or error. No real socket; no real server.
 */

// deno-lint-ignore-file no-explicit-any

import { assertEquals, assertRejects } from "@std/assert";
import { WebSocketClient } from "./client.ts";
import { RequestError } from "../errors.ts";

interface MockEvent {
  data?: string;
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  sentFrames: unknown[] = [];
  private listeners: Map<string, Set<(e: any) => void>> = new Map();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    // Auto-open on the next microtask, so the client can attach
    // listeners synchronously before we transition.
    queueMicrotask(() => this.openNow());
  }

  addEventListener(name: string, cb: (e: any) => void, _opts?: unknown): void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(cb);
  }
  removeEventListener(name: string, cb: (e: any) => void): void {
    this.listeners.get(name)?.delete(cb);
  }

  send(data: string): void {
    this.sentFrames.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", {});
  }

  // ── test helpers ──
  openNow(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", {});
  }
  pushMessage(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) } as MockEvent);
  }
  emitError(): void {
    this.emit("error", {});
  }
  emit(name: string, event: unknown): void {
    for (const cb of this.listeners.get(name) ?? []) cb(event);
  }
}

function installMockWs(): { restore: () => void } {
  const originalWS = (globalThis as any).WebSocket;
  MockWebSocket.instances = [];
  (globalThis as any).WebSocket = MockWebSocket;
  return {
    restore: () => {
      (globalThis as any).WebSocket = originalWS;
    },
  };
}

/**
 * Wait until the client has sent at least `count` frames on the
 * latest socket, then return them. Polls via microtasks/setTimeout.
 */
async function waitForFrames(count: number, maxMs = 2000): Promise<unknown[]> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const ws = MockWebSocket.instances.at(-1);
    if (ws && ws.sentFrames.length >= count) return ws.sentFrames.slice();
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `waitForFrames: expected ${count}, got ${
      MockWebSocket.instances.at(-1)?.sentFrames.length ?? 0
    }`,
  );
}

/**
 * Drive a single-RPC test: kick off the client call, wait for the
 * outgoing frame to land on the socket, then route a reply derived
 * from its id and resolve to the awaited result.
 */
async function rpc<T>(
  promise: Promise<T>,
  reply: (id: string) => unknown,
): Promise<T> {
  await waitForFrames(1);
  const ws = MockWebSocket.instances.at(-1)!;
  const last = ws.sentFrames.at(-1) as { id: string };
  ws.pushMessage(reply(last.id));
  return await promise;
}

// ── Connection lifecycle ──

Deno.test("client: opens a single socket; subsequent calls reuse it", async () => {
  const { restore } = installMockWs();
  try {
    const c = new WebSocketClient({
      url: "ws://h",
      reconnect: { enabled: false },
    });
    await rpc(c.status(), (id) => ({ id, success: true, data: { status: "healthy" } }));
    await rpc(c.status(), (id) => ({ id, success: true, data: { status: "healthy" } }));
    assertEquals(MockWebSocket.instances.length, 1);
  } finally {
    restore();
  }
});

Deno.test("client: resolves URL provider function on first connect", async () => {
  const { restore } = installMockWs();
  try {
    let calls = 0;
    const c = new WebSocketClient({
      url: () => {
        calls++;
        return Promise.resolve("ws://dynamic/" + calls);
      },
      reconnect: { enabled: false },
    });
    await rpc(c.status(), (id) => ({ id, success: true, data: { status: "ok" } }));
    assertEquals(MockWebSocket.instances[0].url, "ws://dynamic/1");
    assertEquals(calls, 1);
  } finally {
    restore();
  }
});

// ── Unary RPC envelope shapes ──

Deno.test("status: sends { type: 'status', payload: {} }, returns server data", async () => {
  const { restore } = installMockWs();
  try {
    const c = new WebSocketClient({ url: "ws://h", reconnect: { enabled: false } });
    const s = await rpc(
      c.status(),
      (id) => ({ id, success: true, data: { status: "healthy", message: "ok" } }),
    );
    assertEquals(s, { status: "healthy", message: "ok" });
    const sent = MockWebSocket.instances[0].sentFrames[0] as {
      type: string;
      payload: unknown;
      id: string;
    };
    assertEquals(sent.type, "status");
    assertEquals(sent.payload, {});
    assertEquals(typeof sent.id, "string");
  } finally {
    restore();
  }
});

Deno.test("read: sends { type: 'read', payload: { urls } }, returns Output[]", async () => {
  const { restore } = installMockWs();
  try {
    const c = new WebSocketClient({ url: "ws://h", reconnect: { enabled: false } });
    const expected: [string, unknown][] = [["mutable://a", { v: 1 }]];
    const out = await rpc(
      c.read(["mutable://a"]),
      (id) => ({ id, success: true, data: expected }),
    );
    assertEquals(out, expected);
    const sent = MockWebSocket.instances[0].sentFrames[0] as { payload: unknown };
    assertEquals(sent.payload, { urls: ["mutable://a"] });
  } finally {
    restore();
  }
});

Deno.test("read: empty urls returns [] without sending", async () => {
  const { restore } = installMockWs();
  try {
    const c = new WebSocketClient({ url: "ws://h", reconnect: { enabled: false } });
    const out = await c.read([]);
    assertEquals(out, []);
    assertEquals(MockWebSocket.instances.length, 0);
  } finally {
    restore();
  }
});

Deno.test("receive: sends { type: 'receive', payload: msgs }, returns ReceiveResult[]", async () => {
  const { restore } = installMockWs();
  try {
    const c = new WebSocketClient({ url: "ws://h", reconnect: { enabled: false } });
    const out = await rpc(
      c.receive([["mutable://x", { v: 1 }]]),
      (id) => ({ id, success: true, data: [{ accepted: true }] }),
    );
    assertEquals(out, [{ accepted: true }]);
    const sent = MockWebSocket.instances[0].sentFrames[0] as { payload: unknown };
    assertEquals(sent.payload, [["mutable://x", { v: 1 }]]);
  } finally {
    restore();
  }
});

Deno.test("receive: on transport error returns per-slot error (does not throw)", async () => {
  const { restore } = installMockWs();
  try {
    const c = new WebSocketClient({
      url: "ws://h",
      reconnect: { enabled: false },
    });
    const out = await rpc(
      c.receive([
        ["mutable://a", { v: 1 }],
        ["mutable://b", { v: 2 }],
      ]),
      (id) => ({ id, success: false, error: "bad" }),
    );
    assertEquals(out, [
      { accepted: false, error: "bad" },
      { accepted: false, error: "bad" },
    ]);
  } finally {
    restore();
  }
});

// ── Error envelope mapping ──

Deno.test("read: server { success: false, error } → RequestError", async () => {
  const { restore } = installMockWs();
  try {
    const c = new WebSocketClient({ url: "ws://h", reconnect: { enabled: false } });
    const err = await assertRejects(
      () =>
        rpc(c.read(["mutable://x"]), (id) => ({
          id,
          success: false,
          error: "bad payload",
        })),
      RequestError,
      "bad payload",
    );
    assertEquals(err.transport, "ws");
    assertEquals(err.operation, "read");
  } finally {
    restore();
  }
});

Deno.test("status: server error → returns unhealthy (does not throw)", async () => {
  const { restore } = installMockWs();
  try {
    const c = new WebSocketClient({ url: "ws://h", reconnect: { enabled: false } });
    const s = await rpc(
      c.status(),
      (id) => ({ id, success: false, error: "no" }),
    );
    assertEquals(s.status, "unhealthy");
    assertEquals(typeof s.message === "string" && s.message.includes("no"), true);
  } finally {
    restore();
  }
});

// ── Response routing by id ──

Deno.test("client: two in-flight requests resolved by id (out of order)", async () => {
  const { restore } = installMockWs();
  try {
    const c = new WebSocketClient({ url: "ws://h", reconnect: { enabled: false } });
    const a = c.status();
    const b = c.read(["mutable://x"]);
    await waitForFrames(2);
    const ws = MockWebSocket.instances[0];
    const [statusFrame, readFrame] = ws.sentFrames as Array<
      { id: string; type: string }
    >;
    assertEquals(statusFrame.type, "status");
    assertEquals(readFrame.type, "read");
    ws.pushMessage({ id: readFrame.id, success: true, data: [["mutable://x", 1]] });
    ws.pushMessage({ id: statusFrame.id, success: true, data: { status: "healthy" } });
    assertEquals(await b, [["mutable://x", 1]]);
    assertEquals((await a).status, "healthy");
  } finally {
    restore();
  }
});

// ── preSend hook ──

Deno.test("preSend: hook can mutate envelope before send", async () => {
  const { restore } = installMockWs();
  try {
    const c = new WebSocketClient({
      url: "ws://h",
      reconnect: { enabled: false },
      preSend: (env) => {
        (env as Record<string, unknown>).auth = "Bearer x";
      },
    });
    await rpc(c.status(), (id) => ({ id, success: true, data: { status: "ok" } }));
    const sent = MockWebSocket.instances[0].sentFrames[0] as Record<string, unknown>;
    assertEquals(sent.auth, "Bearer x");
  } finally {
    restore();
  }
});
