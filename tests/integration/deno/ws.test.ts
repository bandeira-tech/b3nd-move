/**
 * WebSocket — in-Deno integration: real `wsApi` + real
 * `WebSocketClient` against an in-process Map-backed rig.
 */

/// <reference lib="deno.ns" />

import { pinContract } from "../../suites/pin-contract.ts";
import { startWsServer } from "../../factories/ws.ts";
import { testRig } from "../../rigs/memory.ts";
import { WebSocketClient } from "../../../src/ws/client.ts";

pinContract("ws", async () => {
  const server = await startWsServer(testRig());
  const client = new WebSocketClient({
    url: server.url,
    reconnect: { enabled: false },
  });
  return { client, cleanup: () => Promise.resolve(server.stop()) };
});
