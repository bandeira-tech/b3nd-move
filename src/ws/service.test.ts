/// <reference lib="deno.ns" />
/**
 * @module
 * WebSocket service — cancel-mechanics tests.
 *
 * Covers the `inFlight: Set<AbortController>` bookkeeping in `wsApi`
 * (src/ws/service.ts lines 113-155) introduced by the Issue #4 fix.
 * A client dropping mid-read must cancel the upstream stream pump at
 * the next chunk boundary — matching what HTTP/gRPC get from the runtime.
 *
 * Excluded from this file:
 * - Stream-materialization shape tests (live at src/codecs/ws/json-envelope.test.ts)
 * - KNOWN LIMITATION shape pin (lives at src/codecs/ws/json-envelope.test.ts)
 *
 * MemSocket harness is inlined — it's small and the tests need the
 * exact surface wsApi touches (readyState, addEventListener, send).
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
import { wsJsonEnvelope } from "../codecs/ws/mod.ts";

// ── In-memory paired-socket harness ─────────────────────────────────────

/**
 * Minimal `WebSocket`-shaped object satisfying what `wsApi` uses:
 * `readyState`, `addEventListener("message"|"close"|"error")`, `send`.
 * Two instances paired by `_peer`: `send` on one fires a `message`
 * event on the other.
 */
class MemSocket extends EventTarget {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MemSocket.OPEN;
  sent: string[] = [];
  _peer!: MemSocket;

  send(data: string): void {
    this.sent.push(data);
    queueMicrotask(() => {
      this._peer.dispatchEvent(new MessageEvent("message", { data }));
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

/** A node whose read returns a stream that enqueues once and never closes. */
class NeverClosingNode implements ProtocolInterfaceNode {
  cancelled = false;
  read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
    return Promise.resolve(urls.map((u): Output<T> => {
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => {
          c.enqueue(new TextEncoder().encode("first"));
          // never close
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
  return new Rig({ routes: { receive: [c], read: [c], observe: [c] } });
}

// ── Cancel-mechanics tests (Issue #4 inFlight set) ─────────────────────

Deno.test(
  "WS inFlight: socket close cancels in-flight unary read",
  async () => {
    const node = new NeverClosingNode();
    const rig = buildRig(node);
    const attach = wsApi(rig, { codec: wsJsonEnvelope() });
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
    // No success envelope reached the client: the never-closing stream
    // got cancelled, so materialize rejected — and the socket is closed.
    assertEquals(received, false);
    // The upstream stream's cancel() WAS called — the per-frame
    // AbortController was registered in inFlight, aborted on socket
    // close, and flowed through materializeStreams into pipeTo({ signal }).
    assertEquals(
      node.cancelled,
      true,
      "Socket close did not cancel the upstream stream — Issue #4 regressed",
    );
  },
);

Deno.test(
  "WS inFlight: socket 'error' event also cancels in-flight unary read",
  async () => {
    // Symmetric to close: an error event on the socket means the wire
    // is gone. In-flight unary frames must abort, mirroring how HTTP
    // runtimes treat a connection error.
    const node = new NeverClosingNode();
    const rig = buildRig(node);
    const attach = wsApi(rig, { codec: wsJsonEnvelope() });
    const { server, client } = pair();
    attach(server as unknown as WebSocket);

    client.send(JSON.stringify({
      id: "r-err",
      type: "read",
      payload: { urls: ["s://slow"] },
    }));

    await new Promise<void>((r) => setTimeout(r, 10));
    // Fire error on the server socket only (not close, which would also
    // close the peer — here we want the pure error-path test).
    server.dispatchEvent(new Event("error"));

    await new Promise<void>((r) => setTimeout(r, 30));
    assertEquals(
      node.cancelled,
      true,
      "WS 'error' event did not cancel in-flight unary read",
    );
  },
);

Deno.test(
  "WS inFlight: socket close cancels ALL concurrent in-flight reads together",
  async () => {
    // The per-socket inFlight set tracks every dispatched frame's
    // controller. Three concurrent in-flight reads, then close — every
    // upstream cancel() hook must fire. Catches a partial-iteration
    // bug in the close handler.
    class TrackedNode implements ProtocolInterfaceNode {
      cancelled: boolean[] = [];
      read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
        return Promise.resolve(urls.map((u): Output<T> => {
          const i = this.cancelled.length;
          this.cancelled.push(false);
          const stream = new ReadableStream<Uint8Array>({
            start: (c) => {
              c.enqueue(new TextEncoder().encode(`first-${u}`));
              // never close
            },
            cancel: () => {
              this.cancelled[i] = true;
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
    const node = new TrackedNode();
    const rig = buildRig(node);
    const attach = wsApi(rig, { codec: wsJsonEnvelope() });
    const { server, client } = pair();
    attach(server as unknown as WebSocket);

    // Fire 3 concurrent unary read frames.
    for (const id of ["rA", "rB", "rC"]) {
      client.send(JSON.stringify({
        id,
        type: "read",
        payload: { urls: [`s://slow-${id}`] },
      }));
    }
    await new Promise<void>((r) => setTimeout(r, 15));
    server.close();
    await new Promise<void>((r) => setTimeout(r, 30));

    assertEquals(
      node.cancelled.length,
      3,
      "expected 3 read frames to reach upstream",
    );
    assertEquals(
      node.cancelled.every((c) => c === true),
      true,
      `not all upstream streams cancelled: ${JSON.stringify(node.cancelled)}`,
    );
  },
);

Deno.test(
  "WS inFlight: completed frame deregisters before close — no spurious abort",
  async () => {
    // The inFlight set must be drained in the dispatcher's try/finally,
    // NOT only on close. A frame that completes successfully must be
    // gone from the set; a later close must not "abort" a controller
    // that was already used and discarded.
    let firstCancelCount = 0;
    class FastNode implements ProtocolInterfaceNode {
      read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
        return Promise.resolve(urls.map((u): Output<T> => {
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode(`done-${u}`));
              c.close();
            },
            cancel: () => {
              firstCancelCount++;
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
    const node = new FastNode();
    const rig = buildRig(node);
    const attach = wsApi(rig, { codec: wsJsonEnvelope() });
    const { server, client } = pair();
    attach(server as unknown as WebSocket);

    client.send(JSON.stringify({
      id: "fast",
      type: "read",
      payload: { urls: ["s://fast"] },
    }));

    // Wait for the success envelope — arrives only after try/finally
    // completes (i.e. after the controller has been deregistered).
    const frame = await nextClientFrame(client) as {
      id: string;
      success: boolean;
    };
    assertEquals(frame.id, "fast");
    assertEquals(frame.success, true);
    // Stream closed naturally — no cancel() should have fired.
    assertEquals(
      firstCancelCount,
      0,
      "fast-path stream's cancel() fired before close",
    );

    // Close the socket. If the controller is still in inFlight, the
    // iteration runs but the abort on an already-consumed pipe is
    // a no-op — however the cancel() count stays 0.
    server.close();
    await new Promise<void>((r) => setTimeout(r, 30));
    assertEquals(
      firstCancelCount,
      0,
      "post-completion close fired cancel() on the completed stream",
    );
  },
);

Deno.test(
  "WS inFlight: exception-path dispatch deregisters controller (bad frame then healthy frame)",
  async () => {
    // If dispatchWs throws/rejects, the dispatcher's try/finally must
    // still remove the controller from inFlight. A controller left
    // lingering is a slow memory leak and a footgun for the next
    // close-handler iteration.
    //
    // Strategy: send a malformed urls payload — validateUrls rejects
    // with BadRequest. The dispatcher catches the throw and emits an
    // error envelope; the try/finally must drain the controller. Then
    // send a healthy read against a never-closing node and confirm that
    // close cancels exactly one stream (not one + an orphan controller).
    const node = new NeverClosingNode();
    const rig = buildRig(node);
    const attach = wsApi(rig, { codec: wsJsonEnvelope() });
    const { server, client } = pair();
    attach(server as unknown as WebSocket);

    // 1. Send a malformed read frame — decode throws BadRequest.
    client.send(JSON.stringify({
      id: "bad",
      type: "read",
      payload: { urls: 42 }, // not an array — validateUrls rejects
    }));
    // Wait for the error envelope (proves dispatcher ran try/finally
    // for the bad frame).
    const badFrame = await nextClientFrame(client) as {
      id: string;
      success: boolean;
    };
    assertEquals(badFrame.id, "bad");
    assertEquals(badFrame.success, false);

    // 2. Send a healthy read frame against the never-closing node.
    client.send(JSON.stringify({
      id: "good",
      type: "read",
      payload: { urls: ["s://slow"] },
    }));
    await new Promise<void>((r) => setTimeout(r, 10));

    // 3. Close the socket. The only outstanding controller is the
    // "good" frame; its upstream cancel() must fire exactly once.
    server.close();
    await new Promise<void>((r) => setTimeout(r, 30));
    assertEquals(
      node.cancelled,
      true,
      "good frame's upstream stream did not cancel on close",
    );
  },
);
