/**
 * WebSocket — in-Deno integration: real `wsApi` + real
 * `WebSocketClient` against the stub rig.
 */

/// <reference lib="deno.ns" />

import { runMoveSuite } from "../../suites/move-suite.ts";
import { startWsServer } from "../../factories/ws.ts";
import { stubRig } from "../../rig.ts";
import { WebSocketClient } from "../../../src/ws/client.ts";

const server = await startWsServer(stubRig());

runMoveSuite("WebSocketClient (deno)", {
  client: () =>
    new WebSocketClient({
      url: server.url,
      reconnect: { enabled: false },
    }),
});

Deno.test({
  name: "WebSocketClient (deno) — cleanup",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => Promise.resolve(server.stop()),
});
