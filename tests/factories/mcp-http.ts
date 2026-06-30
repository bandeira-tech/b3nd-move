// deno-lint-ignore-file no-import-prefix
/**
 * MCP-over-HTTP transport factory for integration tests.
 *
 * Binds `mcpHttpApi(rig)` to a random local port via `Deno.serve`,
 * connects the SDK `Client` over `StreamableHTTPClientTransport`, and
 * returns the same `{ client, cleanup }` shape as the in-process MCP
 * factory so the shared `mcpSpec` suite can drive both transports.
 *
 * This is the over-the-wire counterpart to `startMcpInProcess` — same
 * tool surface, real HTTP framing on the wire. The point is to lock
 * the Streamable-HTTP-mounted server's behavior against the same
 * spec that the in-memory one already passes.
 */

/// <reference lib="deno.ns" />

import { Client } from "npm:@modelcontextprotocol/sdk@^1.0.0/client/index.js";
import { StreamableHTTPClientTransport } from "npm:@modelcontextprotocol/sdk@^1.0.0/client/streamableHttp.js";
import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import { mcpHttpApi } from "../../src/mcp/http/service.ts";
import { mcpTextJsonStringify } from "../../src/codecs/mcp/mod.ts";

export interface McpHttpHandle {
  client: Client;
  cleanup: () => Promise<void>;
}

export async function startMcpOverHttp(rig: Rig): Promise<McpHttpHandle> {
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    mcpHttpApi(rig, {
      codec: mcpTextJsonStringify(),
      name: "b3nd-mcp-test",
      version: "0.0.0",
    }),
  );
  const { hostname, port } = server.addr as Deno.NetAddr;
  const url = new URL(`http://${hostname}:${port}/`);

  const client = new Client({
    name: "b3nd-mcp-test-client",
    version: "0.0.0",
  });
  await client.connect(new StreamableHTTPClientTransport(url));

  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.shutdown();
    },
  };
}
