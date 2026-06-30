/**
 * WebSocket transport factory for integration tests.
 *
 * Boots `wsApi(rig, { codec })` on an ephemeral loopback port. WebSocket
 * handshakes are not subject to CORS in browsers, so there is no `withCors`
 * wrap.
 *
 * The factory owns the upgrade (`Deno.upgradeWebSocket`) and the
 * drain set — the library only sees one open socket at a time. `stop`
 * closes every still-open socket before shutting down the listener;
 * `Deno.HttpServer.shutdown()` waits on requests but WS connections
 * are long-lived.
 */

/// <reference lib="deno.ns" />

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import { wsApi } from "../../src/ws/service.ts";
import type { WsBatchCodec } from "../../src/ws/codec.ts";
import type { ServerHandle } from "./http.ts";

export interface WsServerOptions {
  codec: WsBatchCodec;
}

export function startWsServer(
  rig: Rig,
  options: WsServerOptions,
): Promise<ServerHandle> {
  const attach = wsApi(rig, options);
  const sockets = new Set<WebSocket>();
  const handler = (req: Request): Response => {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("Not Found", { status: 404 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    sockets.add(socket);
    socket.addEventListener(
      "close",
      () => sockets.delete(socket),
      { once: true },
    );
    attach(socket);
    return response;
  };
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    handler,
  );
  const { port } = server.addr as Deno.NetAddr;
  return Promise.resolve({
    url: `ws://127.0.0.1:${port}`,
    stop: async () => {
      await drain(sockets);
      await server.shutdown();
    },
  });
}

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
