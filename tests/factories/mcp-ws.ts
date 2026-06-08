/**
 * MCP-over-WS transport factory for integration tests.
 *
 * Binds `mcpWsApi(rig)` to a random local port via `Deno.serve`,
 * connects the SDK `Client` over `WebSocketClientTransport`, and
 * returns the same `{ client, cleanup }` shape as the other MCP
 * factories so the shared `mcpSpec` suite can drive WS too.
 */

/// <reference lib="deno.ns" />

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import { mcpWsApi } from "../../src/mcp/ws/service.ts";

export interface McpWsHandle {
  client: Client;
  cleanup: () => Promise<void>;
}

export async function startMcpOverWs(rig: Rig): Promise<McpWsHandle> {
  const handler = mcpWsApi(rig, { name: "b3nd-mcp-test", version: "0.0.0" });
  const server = Deno.serve({ port: 0, onListen: () => {} }, handler);
  const { hostname, port } = server.addr as Deno.NetAddr;
  const url = new URL(`ws://${hostname}:${port}/`);

  const client = new Client({
    name: "b3nd-mcp-test-client",
    version: "0.0.0",
  });
  await client.connect(new WebSocketClientTransport(url));

  return {
    client,
    cleanup: async () => {
      await client.close();
      await handler.closeAll();
      await server.shutdown();
    },
  };
}
