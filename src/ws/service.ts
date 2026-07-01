/**
 * @module
 * WebSocket service — `wsApi(rig, { codec })` returns a function that
 * attaches the b3nd WS wire protocol to an already-open `WebSocket`. The
 * host is responsible for the upgrade (`Deno.upgradeWebSocket`, CF's
 * `WebSocketPair`, Node's `ws`) and for any cross-socket lifecycle
 * (drain on shutdown, tracking, etc.) — the library only knows about
 * one socket at a time.
 *
 * Wire protocol (matches `WebSocketClient`):
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
 * On socket close (or error), every active observe is aborted and the
 * map is cleared; every in-flight unary frame (`read`/`receive`/
 * `status`) is also aborted via a separate per-socket `inFlight` set of
 * `AbortController`s. The dispatcher's per-frame controller is
 * registered on entry and deregistered on completion (success or
 * failure), so a client dropping mid-`read` cancels the upstream stream
 * pump at the next chunk boundary — matching the HTTP/gRPC contract
 * the runtime gives for free.
 *
 * Graceful drain across many sockets is the host's job — it has every
 * socket it ever passed in.
 *
 * @example Deno
 * ```ts
 * import { wsJsonEnvelope } from "@bandeira-tech/b3nd-move/codecs/ws";
 * const attach = wsApi(rig, { codec: wsJsonEnvelope() });
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
 * import { wsJsonEnvelope } from "@bandeira-tech/b3nd-move/codecs/ws";
 * export class B3ndSession {
 *   #attach = wsApi(this.rig, { codec: wsJsonEnvelope() });
 *   fetch(req: Request) {
 *     const [client, server] = Object.values(new WebSocketPair());
 *     server.accept();
 *     this.#attach(server);
 *     return new Response(null, { status: 101, webSocket: client });
 *   }
 * }
 * ```
 */

import type { ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core/types";
import type { WebSocketRequest, WebSocketResponse } from "./client.ts";
import { dispatchWs } from "./router.ts";
import { observeRoute } from "./observe.ts";
import { observeCancelRoute } from "./observe-cancel.ts";
import { readRoute } from "./read.ts";
import { receiveRoute } from "./receive.ts";
import { statusRoute } from "./status.ts";
import type { WsBatchCodec } from "./codec.ts";

/**
 * Attach the b3nd WS wire protocol to an already-open `WebSocket`. The
 * socket must be in the `CONNECTING` or `OPEN` state — `attach` wires
 * the listeners and returns immediately; the actual dispatch happens
 * when frames arrive.
 */
export type WsApi = (socket: WebSocket) => void;

/** Options for `wsApi`. */
export interface WsApiOptions {
  /** Codec that owns read/receive encode+decode on both server and client. */
  codec: WsBatchCodec;
}

/**
 * Build a b3nd WS attacher bound to a Rig. The returned function takes
 * one socket and wires it up; call it once per upgraded connection.
 */
export function wsApi(
  rig: ProtocolInterfaceNode,
  options: WsApiOptions,
): WsApi {
  const { codec } = options;
  return (socket: WebSocket): void => {
    const observes = new Map<string, AbortController>();
    // In-flight unary frames (`read`/`receive`/`status`). Tracked
    // separately from `observes` so the close handler stays trivial
    // and observes keep their richer lifecycle (`observe-cancel` reuses
    // the id; unary frames have no client-side cancel surface — the
    // socket close IS the cancel). Registered on dispatch, deregistered
    // on completion (success or rejection) via try/finally.
    const inFlight = new Set<AbortController>();
    const routes = [
      statusRoute,
      receiveRoute(codec),
      readRoute(codec),
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
      inFlight.add(abort);
      try {
        for await (const resp of dispatchWs(rig, routes, frame, abort)) {
          send(resp);
        }
      } finally {
        inFlight.delete(abort);
      }
    }

    const abortAll = () => {
      for (const abort of observes.values()) abort.abort();
      observes.clear();
      for (const abort of inFlight) abort.abort();
      inFlight.clear();
    };

    socket.addEventListener("close", abortAll);
    socket.addEventListener("error", abortAll);
  };
}
