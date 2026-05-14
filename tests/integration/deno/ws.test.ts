/**
 * WebSocket — in-Deno integration: real `wsApi` + real
 * `WebSocketClient` against a `MemoryStore`-backed rig.
 */

/// <reference lib="deno.ns" />

import { pinContract } from "../../suites/pin-contract.ts";
import { startWsServer } from "../../factories/ws.ts";
import { memoryRig } from "../../rigs/memory.ts";
import { WebSocketClient } from "../../../src/ws/client.ts";

pinContract("ws", async () => {
  const server = await startWsServer(memoryRig());
  const client = new WebSocketClient({
    url: server.url,
    reconnect: { enabled: false },
  });
  return { client, cleanup: () => Promise.resolve(server.stop()) };
});
