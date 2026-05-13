/**
 * @module
 * In-process WebSocket factory — boots `wsApi(rig)` via `Deno.serve` on
 * an ephemeral port and returns a `WebSocketClient` connected to it.
 *
 * Reconnect is disabled so test teardown doesn't fight an auto-retry
 * loop when the server shuts down.
 */

import { WebSocketClient } from "../../ws/client.ts";
import { wsApi } from "../../ws/service.ts";
import type { ServerFactory } from "../contract.ts";
import { defaultRig } from "./_rig.ts";

export const wsInProcess: ServerFactory = () => {
  const rig = defaultRig();
  const api = wsApi(rig);
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    api,
  );
  const { port } = server.addr as Deno.NetAddr;
  const client = new WebSocketClient({
    url: `ws://127.0.0.1:${port}`,
    reconnect: { enabled: false },
  });
  return Promise.resolve({
    client,
    cleanup: async () => {
      await api.closeAll();
      await server.shutdown();
    },
  });
};
