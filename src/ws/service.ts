/**
 * @module
 * WebSocket service — `wsApi(rig)` as a fetch handler that upgrades the
 * request to a WebSocket and bridges b3nd-core's WS wire protocol to a
 * `Rig`.
 *
 * Wire protocol (matches `@bandeira-tech/b3nd-core`'s `WebSocketClient`):
 *
 *   inbound  → `{ id, type: "receive"|"read"|"observe"|"observe-cancel"|"status", payload }`
 *   outbound → `{ id, success: true,  data }`
 *              `{ id, success: false, error }`
 *
 * Per-type payload shapes:
 *   - `receive`        payload = `Output[]`                 → data = `ReceiveResult[]`
 *   - `read`           payload = `{ urls: string[] }`       → data = `Output[]`
 *   - `observe`        payload = `{ urls: string[] }`       → multiple frames, each
 *                                                             `data = string[]`
 *                                                             (batch of fired uris);
 *                                                             terminator `data = null`
 *   - `observe-cancel` payload = `{}` (reuses observe `id`) → no reply (the active
 *                                                              observe handler emits
 *                                                              the terminator)
 *   - `status`         payload = `{}`                       → data = `StatusResult`
 *
 * Per-type routes (`./{status,receive,read,observe}.ts`) own their
 * decode/encode; `dispatchWs` in `./router.ts` runs the table. The
 * service's only jobs are the WS lifecycle (upgrade, per-socket
 * `observes` map, graceful shutdown) and the one control frame
 * (`observe-cancel`) that operates on that lifecycle rather than the
 * rig.
 *
 * Non-upgrade requests get a 404 — the handler does only the WS path.
 * Compose with `withCors` upstream if browser clients hit this directly.
 *
 * The returned handler exposes `closeAll()` so a transport server can
 * tear down all active sockets gracefully before stopping the listener
 * — important because `Deno.HttpServer.shutdown()` waits for in-flight
 * requests but WS connections are long-lived.
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import type { WebSocketRequest, WebSocketResponse } from "./client.ts";
import { dispatchWs } from "./router.ts";
import { observeRoute } from "./observe.ts";
import { readRoute } from "./read.ts";
import { receiveRoute } from "./receive.ts";
import { statusRoute } from "./status.ts";

/**
 * Fetch handler with a `closeAll` lifecycle hook.
 *
 * Still satisfies `(Request) => Promise<Response>` for any caller that
 * doesn't care about graceful shutdown.
 */
export interface WsApi {
  (req: Request): Promise<Response>;
  /**
   * Close all currently-open WebSocket connections produced by this
   * handler and wait for their close handshake to settle. Idempotent.
   */
  closeAll(): Promise<void>;
}

/**
 * Create a WebSocket request handler backed by a Rig.
 *
 * Returns a fetch handler that — alongside the standard
 * `(Request) => Promise<Response>` call signature — exposes
 * `closeAll()` for graceful teardown.
 */
export function wsApi(rig: Rig): WsApi {
  const sockets = new Set<WebSocket>();
  const routes = [statusRoute, receiveRoute, readRoute, observeRoute];

  const handler = (req: Request): Promise<Response> => {
    if (req.headers.get("upgrade") !== "websocket") {
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }

    const { socket, response } = Deno.upgradeWebSocket(req);
    const observes = new Map<string, AbortController>();
    sockets.add(socket);

    const send = (msg: WebSocketResponse) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    };

    socket.onmessage = (event) => {
      void handleMessage(event);
    };

    async function handleMessage(event: MessageEvent): Promise<void> {
      let frame: WebSocketRequest;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }

      // Control frame: lifecycle-only, never reaches the route table.
      if (frame.type === "observe-cancel") {
        observes.get(frame.id)?.abort();
        return;
      }

      const abort = new AbortController();
      observes.set(frame.id, abort);
      try {
        for await (const resp of dispatchWs(rig, routes, frame, abort)) {
          send(resp);
        }
      } finally {
        observes.delete(frame.id);
      }
    }

    socket.onclose = () => {
      for (const abort of observes.values()) abort.abort();
      observes.clear();
      sockets.delete(socket);
    };

    return Promise.resolve(response);
  };

  (handler as WsApi).closeAll = (): Promise<void> => {
    const waits: Promise<void>[] = [];
    for (const socket of sockets) {
      if (
        socket.readyState === WebSocket.CLOSED ||
        socket.readyState === WebSocket.CLOSING
      ) continue;
      waits.push(
        new Promise<void>((resolve) => {
          const done = () => resolve();
          socket.addEventListener("close", done, { once: true });
          socket.addEventListener("error", done, { once: true });
          try {
            socket.close(1001, "server shutting down");
          } catch {
            resolve();
          }
        }),
      );
    }
    return Promise.all(waits).then(() => {});
  };

  return handler as WsApi;
}
