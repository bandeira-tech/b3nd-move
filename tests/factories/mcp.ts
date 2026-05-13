/**
 * MCP transport factory for integration tests.
 *
 * MCP's transport model is fundamentally different from the others —
 * it links a server to a client over an `InMemoryTransport` pair,
 * no URL, no port, no `Deno.serve`. So this factory's shape differs
 * from the HTTP/WS/gRPC siblings: it returns a connected `Client`
 * directly rather than a `{ url, stop }` pair, and the caller doesn't
 * construct the client itself.
 *
 * Used by `mcpSpec` — the MCP equivalent of `moveSuite`, which has
 * its own shape because MCP wraps everything in tool calls and JSON
 * text content blocks.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import { buildMcpServer } from "../../src/mcp/service.ts";

export interface McpHandle {
  client: Client;
  cleanup: () => Promise<void>;
}

export async function startMcpInProcess(rig: Rig): Promise<McpHandle> {
  const server = buildMcpServer(rig, {
    name: "b3nd-mcp-test",
    version: "0.0.0",
  });
  const client = new Client({
    name: "b3nd-mcp-test-client",
    version: "0.0.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}
