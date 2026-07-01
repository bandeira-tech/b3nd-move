/**
 * MCP-over-HTTP transport plug.
 *
 * Binds `mcpHttpApi(rig)` to a random loopback port via `Deno.serve` and
 * connects the SDK `Client` over `StreamableHTTPClientTransport`. Same
 * `{ client, cleanup }` shape as the in-process plug so the shared
 * `mcpSpec` drives it identically — real HTTP framing on the wire.
 *
 * Publish-excluded test support (see `deno.json`).
 */

// deno-lint-ignore-file no-import-prefix

/// <reference lib="deno.ns" />

import { Client } from "npm:@modelcontextprotocol/sdk@^1.0.0/client/index.js";
import { StreamableHTTPClientTransport } from "npm:@modelcontextprotocol/sdk@^1.0.0/client/streamableHttp.js";
import type { McpPlug } from "../../../../tests/suites/mcp-plug.ts";
import { mcpHttpApi } from "../service.ts";
import { mcpTextJsonStringify } from "../../../codecs/mcp/mod.ts";

export const mcpHttpPlug: McpPlug = {
  name: "mcp-http",
  connect: async (rig) => {
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
  },
};
