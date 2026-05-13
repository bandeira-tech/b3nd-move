/**
 * WebSocket transport stub for browser integration tests.
 *
 * Speaks the b3nd-core WS envelope `WebSocketClient` expects:
 *
 *   inbound  → { id, type: "receive"|"read"|"observe"|"observe-cancel"|"status", payload }
 *   outbound → { id, success: true,  data }
 *              { id, success: false, error }
 *
 * Each operation maps to the same content-addressed echo contract
 * documented in `tests/runners/move-suite.ts`. No rig, no store.
 *
 * Note: WebSocket connections are not subject to CORS — only the
 * initial HTTP upgrade is, and that is loopback-friendly already.
 */

/// <reference lib="deno.ns" />

import type { StubServerHandle } from "../browser-runner.ts";

interface InboundEnvelope {
  id: string;
  type: "receive" | "read" | "observe" | "observe-cancel" | "status";
  payload: unknown;
}

function receiveOne(
  uri: string,
): { accepted: boolean; ref?: string; error?: string } {
  if (uri.includes("/__reject__/")) {
    return { accepted: false, error: "rejected by stub" };
  }
  return { accepted: true, ref: uri };
}

function readOne(url: string): [string, unknown] {
  if (url.includes("/__miss__/")) return [url, null];
  return [url, { echo: url }];
}

/** Start the WS stub server. Listens on a kernel-assigned port. */
export function startWsStub(): Promise<StubServerHandle> {
  const ac = new AbortController();
  const sockets = new Set<WebSocket>();

  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    (req: Request): Response => {
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response("not found", { status: 404 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      sockets.add(socket);

      // Track active observe loops so observe-cancel can stop them.
      const observes = new Map<string, AbortController>();

      const send = (msg: unknown) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(msg));
        }
      };

      socket.onmessage = (event: MessageEvent) => {
        let env: InboundEnvelope;
        try {
          env = JSON.parse(event.data);
        } catch {
          return;
        }
        const { id, type, payload } = env;

        if (type === "receive") {
          const msgs = (payload as [unknown, unknown][]) ?? [];
          const data = msgs.map(([uri]) =>
            typeof uri === "string"
              ? receiveOne(uri)
              : { accepted: false, error: "URI is required" }
          );
          send({ id, success: true, data });
          return;
        }

        if (type === "read") {
          const urls = (payload as { urls?: unknown })?.urls ?? [];
          if (!Array.isArray(urls)) {
            send({ id, success: false, error: "Expected { urls: string[] }" });
            return;
          }
          const data = (urls as string[]).map(readOne);
          send({ id, success: true, data });
          return;
        }

        if (type === "status") {
          send({
            id,
            success: true,
            data: {
              status: "healthy",
              message: "stub",
              fns: ["receive", "read", "observe", "status"],
            },
          });
          return;
        }

        if (type === "observe") {
          const urls = (payload as { urls?: unknown })?.urls ?? [];
          if (!Array.isArray(urls)) {
            send({ id, success: false, error: "Expected { urls: string[] }" });
            return;
          }
          const abort = new AbortController();
          observes.set(id, abort);
          // Emit three frames per subscribed pattern, then the
          // null terminator the client uses as end-of-stream.
          (async () => {
            try {
              for (const pattern of urls as string[]) {
                for (let i = 0; i < 3; i++) {
                  if (abort.signal.aborted) return;
                  send({
                    id,
                    success: true,
                    data: [pattern, [`${pattern}/${i}`]],
                  });
                  // Yield so cancel signals can interleave between frames.
                  await new Promise<void>((r) => setTimeout(r, 0));
                }
              }
            } finally {
              observes.delete(id);
              send({ id, success: true, data: null });
            }
          })();
          return;
        }

        if (type === "observe-cancel") {
          observes.get(id)?.abort();
          return;
        }

        send({ id, success: false, error: `Unknown type: ${type}` });
      };

      socket.onclose = () => {
        for (const abort of observes.values()) abort.abort();
        observes.clear();
        sockets.delete(socket);
      };

      return response;
    },
  );

  return Promise.resolve({
    url: `ws://127.0.0.1:${server.addr.port}`,
    stop: async () => {
      // Close any open sockets before aborting the listener so the
      // server.finished promise resolves cleanly.
      for (const s of sockets) {
        try {
          s.close();
        } catch { /* already closed */ }
      }
      sockets.clear();
      ac.abort();
      await server.finished;
    },
  });
}
