/**
 * @module
 * WebSocket service — `wsApi(rig)` returns a function that attaches the
 * b3nd WS wire protocol to an already-open `WebSocket`. The host is
 * responsible for the upgrade (`Deno.upgradeWebSocket`, CF's
 * `WebSocketPair`, Node's `ws`) and for any cross-socket lifecycle
 * (drain on shutdown, tracking, etc.) — the library only knows about
 * one socket at a time.
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
 * Per-type routes (`./{status,receive,read,observe,observe-cancel}.ts`)
 * own their decode/action/encode; `dispatchWs` in `./router.ts` runs
 * the table. `observe` and `observe-cancel` close over a per-socket
 * `observes` map; the map is created fresh inside `attach` so two
 * sockets can't collide on the same observe id.
 *
 * On socket close, every active observe is aborted and the map is
 * cleared. Graceful drain across many sockets is the host's job — it
 * has every socket it ever passed in.
 *
 * @example Deno
 * ```ts
 * const attach = wsApi(rig);
 * Deno.serve({ port: 8080 }, (req) => {
 *   if (req.headers.get("upgrade") !== "websocket") {
 *     return new Response("Not Found", { status: 404 });
 *   }
 *   const { socket, response } = Deno.upgradeWebSocket(req);
 *   attach(socket);
 *   return response;
 * });
 * ```
 *
 * @example Cloudflare Durable Object
 * ```ts
 * export class B3ndSession {
 *   #attach = wsApi(this.rig);
 *   fetch(req: Request) {
 *     const [client, server] = Object.values(new WebSocketPair());
 *     server.accept();
 *     this.#attach(server);
 *     return new Response(null, { status: 101, webSocket: client });
 *   }
 * }
 * ```
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import type { WebSocketRequest, WebSocketResponse } from "./client.ts";
import { dispatchWs } from "./router.ts";
import { observeRoute } from "./observe.ts";
import { observeCancelRoute } from "./observe-cancel.ts";
import { readRoute } from "./read.ts";
import { receiveRoute } from "./receive.ts";
import { statusRoute } from "./status.ts";

/**
 * Attach the b3nd WS wire protocol to an already-open `WebSocket`. The
 * socket must be in the `CONNECTING` or `OPEN` state — `attach` wires
 * the listeners and returns immediately; the actual dispatch happens
 * when frames arrive.
 */
export type WsApi = (socket: WebSocket) => void;

/**
 * Build a b3nd WS attacher bound to a Rig. The returned function takes
 * one socket and wires it up; call it once per upgraded connection.
 */
export function wsApi(rig: Rig): WsApi {
  return (socket: WebSocket): void => {
    const observes = new Map<string, AbortController>();
    const routes = [
      statusRoute,
      receiveRoute,
      readRoute,
      observeRoute(observes),
      observeCancelRoute(observes),
    ];

    const send = (msg: WebSocketResponse) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    };

    socket.addEventListener("message", (event: MessageEvent) => {
      void handleMessage(event);
    });

    async function handleMessage(event: MessageEvent): Promise<void> {
      let frame: WebSocketRequest;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }

      const abort = new AbortController();
      for await (const resp of dispatchWs(rig, routes, frame, abort)) {
        send(resp);
      }
    }

    socket.addEventListener("close", () => {
      for (const abort of observes.values()) abort.abort();
      observes.clear();
    });
  };
}
