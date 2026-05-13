/**
 * WebSocket transport factory for browser integration tests.
 *
 * Boots the *real* `wsApi(rig)` on an ephemeral port, backed by the
 * stub rig. WS handshakes are not subject to CORS in browsers, so no
 * `withCors` wrap is needed.
 */

/// <reference lib="deno.ns" />

import { wsApi } from "../../../src/ws/service.ts";
import type { StubServerHandle } from "../browser-runner.ts";
import { stubRig } from "../stub-rig.ts";

export function startWsServer(): Promise<StubServerHandle> {
  const rig = stubRig();
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
