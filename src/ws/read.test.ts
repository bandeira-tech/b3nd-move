/// <reference lib="deno.ns" />
/**
 * @module
 * WebSocket read — integration test: rig + `wsApi(rig)` + a paired
 * in-memory socket, end-to-end through the JSON envelope.
 *
 * Proves the round-3 promise on the WS wire: the action layer
 * materializes `ReadableStream<Uint8Array>` payloads before they hit
 * the envelope encoder, so the wire delivers a concrete shape per slot
 * even when upstream (b3nd-save fs/s3/ipfs) hands the rig a stream.
 *
 * Why exercise `wsApi` directly (not just `dispatchWs`): the JSON
 * envelope step is part of the round-trip — `JSON.stringify` is where
 * the lossy `Uint8Array` → `{"0":n,…}` shape lands. The KNOWN
 * LIMITATION test below pins that lossy shape so any future fix to
 * WS byte-encoding fails the assertion and forces a coordinated
 * README/docs update (M1).
 *
 * Background:
 * - PR #50 review (`immutable://open/cc-chat/20260627141221-pr50-review/`)
 * - PR #50 follow-ups (`immutable://open/cc-chat/20260627143222-pr50-followups/`)
 * - round-3 payload contract (`immutable://open/cc-chat/20260624224342-payload-contract/`)
 */

import { assertEquals } from "@std/assert";
import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { wsApi } from "./service.ts";

// ── In-memory paired-socket harness ─────────────────────────────────────

/**
 * Minimal `WebSocket`-shaped object satisfying what `wsApi` uses:
 * `readyState`, `addEventListener("message"|"close")`, `send`. Two
 * instances paired by `_peer`: `send` on one fires a `message` event
 * on the other.
 *
 * Not a real WebSocket, but covers the exact surface `wsApi` touches.
 */
class MemSocket extends EventTarget {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MemSocket.OPEN;
  sent: string[] = [];
  _peer!: MemSocket;

  send(data: string): void {
    this.sent.push(data);
    // Asynchronously deliver to the peer.
    queueMicrotask(() => {
      this._peer.dispatchEvent(
        new MessageEvent("message", { data }),
      );
    });
  }

  close(): void {
    this.readyState = MemSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
    this._peer.readyState = MemSocket.CLOSED;
    this._peer.dispatchEvent(new Event("close"));
  }
}

function pair(): { server: MemSocket; client: MemSocket } {
  const server = new MemSocket();
  const client = new MemSocket();
  server._peer = client;
  client._peer = server;
  return { server, client };
}

/**
 * Wait for the first message frame the client receives, parse it as
 * JSON, and return it. Rejects if no frame arrives within `ms`.
 */
function nextClientFrame(client: MemSocket, ms = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      client.removeEventListener("message", onMsg);
      reject(new Error("nextClientFrame: timeout"));
    }, ms);
    function onMsg(ev: Event) {
      clearTimeout(t);
      client.removeEventListener("message", onMsg);
      resolve(JSON.parse((ev as MessageEvent).data));
    }
    client.addEventListener("message", onMsg);
  });
}

// ── Test nodes ─────────────────────────────────────────────────────────

class StreamingNode implements ProtocolInterfaceNode {
  constructor(private bytes: Uint8Array) {}
  read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
    const bytes = this.bytes;
    return Promise.resolve(urls.map((u): Output<T> => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      });
      return [u, stream] as unknown as Output<T>;
    }));
  }
  receive(): Promise<ReceiveResult[]> {
    return Promise.resolve([]);
  }
  async *observe(): AsyncIterable<readonly string[]> {
    yield [] as readonly string[];
  }
  status(): Promise<StatusResult> {
    return Promise.resolve({ status: "healthy" });
  }
}

class NeverClosingNode implements ProtocolInterfaceNode {
  cancelled = false;
  read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
    return Promise.resolve(urls.map((u): Output<T> => {
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => {
          // Enqueue once; never close.
          c.enqueue(new TextEncoder().encode("first"));
        },
        cancel: () => {
          this.cancelled = true;
        },
      });
      return [u, stream] as unknown as Output<T>;
    }));
  }
  receive(): Promise<ReceiveResult[]> {
    return Promise.resolve([]);
  }
  async *observe(): AsyncIterable<readonly string[]> {
    yield [] as readonly string[];
  }
  status(): Promise<StatusResult> {
    return Promise.resolve({ status: "healthy" });
  }
}

function buildRig(node: ProtocolInterfaceNode): Rig {
  const c = connection(node, ["s://**"]);
  return new Rig({
    routes: { receive: [c], read: [c], observe: [c] },
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

Deno.test(
  "WS read: ReadableStream payload arrives materialized at client (via JSON envelope)",
  async () => {
    const node = new StreamingNode(new TextEncoder().encode("streamed"));
    const rig = buildRig(node);
    const attach = wsApi(rig);
    const { server, client } = pair();
    attach(server as unknown as WebSocket);

    // Send a read request from the client side.
    client.send(JSON.stringify({
      id: "r1",
      type: "read",
      payload: { urls: ["s://x"] },
    }));

    const frame = await nextClientFrame(client) as {
      id: string;
      success: boolean;
      data: Output[];
    };
    assertEquals(frame.id, "r1");
    assertEquals(frame.success, true);
    assertEquals(frame.data.length, 1);
    assertEquals(frame.data[0][0], "s://x");
    // After JSON encode → decode the materialized Uint8Array becomes
    // an object-of-indices `{"0":n,"1":n,…}`. That's the documented
    // (lossy) WS shape; the next test pins it explicitly.
    // Here we only assert the slot reached the client at all.
    // (i.e., readAction did not return a ReadableStream that the
    // encoder couldn't serialize.)
    const payload = frame.data[0][1];
    assertEquals(payload !== null && typeof payload === "object", true);
  },
);

Deno.test(
  "WS read: KNOWN LIMITATION — Uint8Array payload encodes as {0:n,1:n,...} via JSON envelope (see README)",
  async () => {
    // Pins the documented lossy shape. The day someone "fixes" WS
    // byte-encoding (e.g. base64) without updating the WS README + the
    // shared-action JSDoc, this assertion fires and forces a
    // coordinated change.
    const bytes = new Uint8Array([10, 20, 30]);
    const node = new StreamingNode(bytes);
    const rig = buildRig(node);
    const attach = wsApi(rig);
    const { server, client } = pair();
    attach(server as unknown as WebSocket);

    client.send(JSON.stringify({
      id: "r2",
      type: "read",
      payload: { urls: ["s://x"] },
    }));

    const frame = await nextClientFrame(client) as {
      id: string;
      success: boolean;
      data: Output[];
    };
    const payload = frame.data[0][1] as Record<string, number>;
    // After JSON.stringify(Uint8Array([10,20,30])) → '{"0":10,"1":20,"2":30}'.
    // That's what the wire ships today. Honest disclosure beats silent
    // junk; see M1 in PR #50 review verdict.
    assertEquals(payload, { "0": 10, "1": 20, "2": 30 });
  },
);

Deno.test(
  "WS read: socket close cancels in-flight unary read (per-frame inFlight set)",
  async () => {
    // PR #50 M4 threads `AbortSignal` through `materializeStreams` so
    // the action layer can cancel an in-flight stream pump when the
    // dispatcher signal fires. Issue #4 closes the gap one level up:
    // `wsApi` now tracks every dispatched frame's `AbortController` in
    // a per-socket `inFlight` set (separate from the `observes` map so
    // observe's richer lifecycle stays clean) and aborts every entry
    // on socket close OR error. Net: a client dropping mid-read
    // cancels the upstream stream pump at the next chunk boundary —
    // matching what HTTP/gRPC get for free from the runtime.
    const node = new NeverClosingNode();
    const rig = buildRig(node);
    const attach = wsApi(rig);
    const { server, client } = pair();
    attach(server as unknown as WebSocket);

    client.send(JSON.stringify({
      id: "r3",
      type: "read",
      payload: { urls: ["s://slow"] },
    }));

    // Give the dispatcher a couple ticks to start the action.
    await new Promise<void>((r) => setTimeout(r, 10));

    let received = false;
    client.addEventListener("message", () => {
      received = true;
    });
    server.close();

    await new Promise<void>((r) => setTimeout(r, 30));
    // No success envelope reached the client (the never-closing stream
    // got cancelled, so materialize rejected — and the socket is closed,
    // so the error envelope wouldn't be sent either):
    assertEquals(received, false);
    // The upstream stream's `cancel()` WAS called — the per-frame
    // `AbortController` was registered in `inFlight`, aborted on
    // socket close, and flowed through `materializeStreamsWith` into
    // `pipeTo({ signal })`:
    assertEquals(
      node.cancelled,
      true,
      "Socket close did not cancel the upstream stream — Issue #4 regressed",
    );
  },
);
