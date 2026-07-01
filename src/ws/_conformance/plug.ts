/**
 * WebSocket transport plug.
 *
 * Single source of truth for booting the WS transport and building a
 * client against it. The factory owns the upgrade (`Deno.upgradeWebSocket`)
 * and the drain set — the library only ever sees one open socket at a
 * time. `stop` closes every still-open socket before shutting the
 * listener down, since WS connections are long-lived and
 * `Deno.HttpServer.shutdown()` only waits on requests.
 *
 * WebSocket handshakes are not subject to browser CORS, so `StartOpts.cors`
 * is ignored here. `reconnect: { enabled: false }` keeps the client from
 * swallowing a closed socket — the suite wants transport behavior, not
 * background recovery.
 *
 * Publish-excluded test support (see `deno.json`).
 */

/// <reference lib="deno.ns" />

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  MovePlug,
  ServerHandle,
} from "../../../tests/suites/move-plug.ts";
import { wsApi } from "../service.ts";
import { WebSocketClient } from "../client.ts";
import { wsJsonEnvelope } from "../../codecs/ws/mod.ts";

const codec = wsJsonEnvelope();

export const wsPlug: MovePlug = {
  name: "ws",
  startServer: (rig: Rig): ServerHandle => {
    const attach = wsApi(rig, { codec });
    const sockets = new Set<WebSocket>();
    const handler = (req: Request): Response => {
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response("Not Found", { status: 404 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      sockets.add(socket);
      socket.addEventListener("close", () => sockets.delete(socket), {
        once: true,
      });
      attach(socket);
      return response;
    };
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      handler,
    );
    const { port } = server.addr as Deno.NetAddr;
    return {
      url: `ws://127.0.0.1:${port}`,
      stop: async () => {
        await drain(sockets);
        await server.shutdown();
      },
    };
  },
  makeClient: (url) =>
    new WebSocketClient({ url, codec, reconnect: { enabled: false } }),
};

function drain(sockets: Set<WebSocket>): Promise<void> {
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
          socket.close(1001, "test teardown");
        } catch {
          resolve();
        }
      }),
    );
  }
  return Promise.all(waits).then(() => {});
}
