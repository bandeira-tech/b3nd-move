/**
 * In-process MCP transport plug.
 *
 * MCP's transport model differs from the PIN-wire transports: it links a
 * server to a client over an `InMemoryTransport` pair — no URL, no port,
 * no `Deno.serve` — so the plug's `connect(rig)` returns a connected SDK
 * `Client` plus a cleanup hook rather than a `{ url, stop }` handle.
 *
 * Publish-excluded test support (see `deno.json`).
 */

// deno-lint-ignore-file no-import-prefix

import { Client } from "npm:@modelcontextprotocol/sdk@^1.0.0/client/index.js";
import { InMemoryTransport } from "npm:@modelcontextprotocol/sdk@^1.0.0/inMemory.js";
import type { McpPlug } from "../../../tests/suites/mcp-plug.ts";
import { buildMcpServer } from "../service.ts";
import { mcpTextJsonStringify } from "../../codecs/mcp/mod.ts";

export const mcpInProcessPlug: McpPlug = {
  name: "mcp",
  connect: async (rig) => {
    const server = buildMcpServer(rig, {
      name: "b3nd-mcp-test",
      version: "0.0.0",
      codec: mcpTextJsonStringify(),
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
  },
};
