/**
 * @module
 * In-process MCP factory — builds an MCP server via `buildMcpServer(rig)`,
 * links it to an MCP SDK `Client` over `InMemoryTransport`, and returns
 * the connected client.
 *
 * No stdio, no spawn — entirely in-process. Exercises the tool surface
 * of `src/mcp/` against a real client.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../mcp/service.ts";
import type { McpFactory } from "../mcp-spec.ts";
import { defaultRig } from "./_rig.ts";

export const mcpInProcess: McpFactory = async () => {
  const rig = defaultRig();
  const server = buildMcpServer(rig, {
    name: "b3nd-mcp-test",
    version: "0.0.0",
  });
  const client = new Client({ name: "b3nd-mcp-test-client", version: "0.0.0" });
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
};
