/**
 * WebSocket — in-Deno integration: real `wsApi` + real `WebSocketClient`
 * against `stubRig` (canned responses). Drives `runMoveSuite` to assert
 * wire fidelity — that frames carry the PIN API across the WS boundary
 * with shapes intact.
 *
 * Each test gets a fresh client so subscriptions/observes don't bleed
 * across tests; the server is shared and stateless.
 */

/// <reference lib="deno.ns" />

import { runMoveSuite } from "../../suites/move-suite.ts";
import { startWsServer } from "../../factories/ws.ts";
import { stubRig } from "../../rigs/stub.ts";
import { WebSocketClient } from "../../../src/ws/client.ts";
import { wsJsonEnvelope } from "../../../src/codecs/ws/mod.ts";

const codec = wsJsonEnvelope();
const server = await startWsServer(stubRig(), { codec });

runMoveSuite("ws", {
  client: () =>
    new WebSocketClient({
      url: server.url,
      codec,
      reconnect: { enabled: false },
    }),
});

Deno.test({
  name: "[ws] teardown",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => server.stop(),
});
