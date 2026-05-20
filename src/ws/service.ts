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
import { runAction } from "../actions/run.ts";
import { validateOutputs, validateUrls } from "../actions/validate.ts";

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
      let raw: WebSocketRequest;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return;
      }
      const { id, type, payload } = raw;

      try {
        switch (type) {
          case "receive": {
            const v = validateOutputs(payload);
            if (!v.ok) {
              send({ id, success: false, error: v.error });
              return;
            }
            const data = await runAction(rig, {
              action: "receive",
              outputs: v.value,
            });
            send({ id, success: true, data });
            return;
          }
          case "read": {
            const v = validateUrls(
              (payload as { urls?: unknown } | null)?.urls,
            );
            if (!v.ok) {
              send({ id, success: false, error: v.error });
              return;
            }
            const data = await runAction(rig, {
              action: "read",
              urls: v.value,
            });
            send({ id, success: true, data });
            return;
          }
          case "status": {
            const data = await runAction(rig, { action: "status" });
            send({ id, success: true, data });
            return;
          }
          case "observe": {
            const v = validateUrls(
              (payload as { urls?: unknown } | null)?.urls,
            );
            if (!v.ok) {
              send({ id, success: false, error: v.error });
              return;
            }
            const abort = new AbortController();
            observes.set(id, abort);
            try {
              const frames = runAction(rig, {
                action: "observe",
                urls: v.value,
                signal: abort.signal,
              });
              for await (const frame of frames) {
                if (abort.signal.aborted) break;
                send({ id, success: true, data: frame });
              }
            } finally {
              observes.delete(id);
              send({ id, success: true, data: null });
            }
            return;
          }
          case "observe-cancel": {
            observes.get(id)?.abort();
            return;
          }
          default:
            send({ id, success: false, error: `Unknown type: ${type}` });
        }
      } catch (e) {
        send({
          id,
          success: false,
          error: e instanceof Error ? e.message : String(e),
        });
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
