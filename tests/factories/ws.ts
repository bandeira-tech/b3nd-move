/**
 * WebSocket transport factory for integration tests.
 *
 * Boots `wsApi(rig)` on an ephemeral loopback port. WebSocket handshakes
 * are not subject to CORS in browsers, so there is no `withCors` wrap.
 * `stop` calls `wsApi.closeAll()` so in-flight sockets settle before the
 * listener shuts down — `Deno.HttpServer.shutdown()` waits on requests
 * but WS connections are long-lived.
 */

/// <reference lib="deno.ns" />

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import { wsApi } from "../../src/ws/service.ts";
import type { ServerHandle } from "./http.ts";

export function startWsServer(rig: Rig): Promise<ServerHandle> {
  const api = wsApi(rig);
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    api,
  );
  const { port } = server.addr as Deno.NetAddr;
  return Promise.resolve({
    url: `ws://127.0.0.1:${port}`,
    stop: async () => {
      await api.closeAll();
      await server.shutdown();
    },
  });
}
