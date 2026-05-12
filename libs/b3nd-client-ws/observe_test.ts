/// <reference lib="deno.ns" />

// deno-lint-ignore-file no-explicit-any

/**
 * WebSocket observe — wire protocol test.
 *
 * **TODO**: this exercises the client against a hand-rolled mock that
 * speaks the observe protocol. The actual server-side implementation
 * lives in `@bandeira-tech/b3nd-servers` (or its successor). When a
 * real WS server lands there, replace the mock with a real-server
 * integration test and keep this file as a unit-level wire-shape pin.
 *
 * Wire protocol locked here:
 *
 *   Subscribe (client → server):
 *     `{ id, type: "observe", payload: { urls: string[] } }`
 *
 *   Event push (server → client, repeated):
 *     `{ id, success: true, data: [inputUrl, uris] }`
 *     where `data` is an `Output<string[]>` package — `inputUrl` is
 *     one of the caller's subscription urls (the one whose pattern
 *     matched) and `uris` is the list of changed uris.
 *
 *   End-of-stream (server → client, optional):
 *     `{ id, success: true, data: null }`
 *
 *   Cancel (client → server):
 *     `{ id, type: "observe-cancel", payload: {} }`
 */

import { assertEquals } from "@std/assert";
import { WebSocketClient } from "./mod.ts";

interface ObserveSub {
  id: string;
  urls: string[];
  push: (uris: string[]) => void;
  end: () => void;
}

/**
 * Mock WS that supports the observe streaming protocol. Captures sent
 * frames so tests can assert on the wire shape, and exposes a `push()`
 * helper to drive event delivery on each subscription.
 */
class ObserveMockWebSocket {
  private listeners: Map<string, Set<(event: any) => void>> = new Map();
  private timers: Set<number> = new Set();
  readyState: number;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: ObserveMockWebSocket[] = [];

  sentFrames: unknown[] = [];
  subs = new Map<string, ObserveSub>();

  constructor(public url: string) {
    this.readyState = ObserveMockWebSocket.CONNECTING;
    ObserveMockWebSocket.instances.push(this);
    const t = setTimeout(() => {
      this.readyState = ObserveMockWebSocket.OPEN;
      this.dispatchEvent({ type: "open" });
    }, 5);
    this.timers.add(t);
  }

  addEventListener(event: string, handler: (event: any) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  removeEventListener(event: string, handler: (event: any) => void) {
    this.listeners.get(event)?.delete(handler);
  }

  dispatchEvent(event: any) {
    this.listeners.get(event.type)?.forEach((h) => h(event));
  }

  send(data: string) {
    const frame = JSON.parse(data);
    this.sentFrames.push(frame);

    if (frame.type === "observe") {
      const id = frame.id as string;
      const urls = (frame.payload?.urls ?? []) as string[];
      this.subs.set(id, {
        id,
        urls,
        push: (uris) => {
          // Tag the package with the first subscription url — the
          // real server would pick the matching pattern; this mock
          // doesn't actually match, so the first url is sufficient.
          this.dispatchEvent({
            type: "message",
            data: JSON.stringify({
              id,
              success: true,
              data: [urls[0], uris],
            }),
          });
        },
        end: () => {
          this.dispatchEvent({
            type: "message",
            data: JSON.stringify({ id, success: true, data: null }),
          });
        },
      });
      return;
    }

    if (frame.type === "observe-cancel") {
      this.subs.get(frame.id)?.end();
      this.subs.delete(frame.id);
      return;
    }
    // No other request types exercised in this file.
  }

  close() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.readyState = ObserveMockWebSocket.CLOSED;
    this.dispatchEvent({ type: "close" });
  }
}

function withMockWS<T>(fn: () => Promise<T>): Promise<T> {
  const original = (globalThis as any).WebSocket;
  (globalThis as any).WebSocket = ObserveMockWebSocket;
  ObserveMockWebSocket.instances.length = 0;
  return fn().finally(() => {
    (globalThis as any).WebSocket = original;
  });
}

Deno.test("WS observe - subscribe frame shape + event delivery", async () => {
  await withMockWS(async () => {
    const client = new WebSocketClient({
      url: "ws://localhost:0",
      reconnect: { enabled: false },
    });

    const ac = new AbortController();
    const seen: string[] = [];

    const done = (async () => {
      for await (const ev of client.observe(["mutable://app/*"], ac.signal)) {
        seen.push(ev[1][0]);
        if (seen.length >= 2) ac.abort();
      }
    })();

    // Wait for the subscribe frame to land.
    await waitFor(() => ObserveMockWebSocket.instances.length > 0);
    const ws = ObserveMockWebSocket.instances[0];
    await waitFor(() => ws.subs.size > 0);

    // Pin subscribe frame shape.
    const subFrame = ws.sentFrames.find(
      (f: any) => f.type === "observe",
    ) as { id: string; type: string; payload: { urls: string[] } };
    assertEquals(subFrame.type, "observe");
    assertEquals(subFrame.payload.urls, ["mutable://app/*"]);
    assertEquals(typeof subFrame.id, "string");

    // Drive two events, expect them to flow through to the iterator.
    const sub = [...ws.subs.values()][0];
    sub.push(["mutable://app/a"]);
    sub.push(["mutable://app/b"]);

    await done;
    assertEquals(seen, ["mutable://app/a", "mutable://app/b"]);

    // Pin cancel frame shape.
    const cancelFrame = ws.sentFrames.find(
      (f: any) => f.type === "observe-cancel",
    ) as { id: string; type: string; payload: unknown } | undefined;
    assertEquals(cancelFrame?.type, "observe-cancel");
    assertEquals(cancelFrame?.id, subFrame.id);
  });
});

Deno.test("WS observe - server end-of-stream terminates iterator", async () => {
  await withMockWS(async () => {
    const client = new WebSocketClient({
      url: "ws://localhost:0",
      reconnect: { enabled: false },
    });

    const ac = new AbortController();
    const seen: string[] = [];

    const done = (async () => {
      for await (const ev of client.observe(["mutable://x/*"], ac.signal)) {
        seen.push(ev[1][0]);
      }
    })();

    await waitFor(() => ObserveMockWebSocket.instances.length > 0);
    const ws = ObserveMockWebSocket.instances[0];
    await waitFor(() => ws.subs.size > 0);
    const sub = [...ws.subs.values()][0];

    sub.push(["mutable://x/1"]);
    sub.end(); // server signals end-of-stream

    await done;
    assertEquals(seen, ["mutable://x/1"]);
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timeout");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
