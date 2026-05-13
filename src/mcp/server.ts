/**
 * @module
 * MCP (Model Context Protocol) server transport for B3nd.
 *
 * Wraps a `Rig` as an MCP server connected over stdio, exposing B3nd
 * data operations and crypto utilities as MCP tools.
 *
 * @example
 * ```typescript
 * import { createServers } from "@bandeira-tech/b3nd-move";
 * import { mcpServer } from "@bandeira-tech/b3nd-move/mcp/server";
 *
 * const servers = createServers(rig, [mcpServer()]);
 * await servers[0].start(); // blocks on stdio
 * ```
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Rig } from "@bandeira-tech/b3nd-core";
import type {
  ServerComposition,
  ServerResolver,
  TransportServer,
} from "../factory.ts";
import { buildMcpServer, type McpServerOptions } from "./service.ts";

class McpTransportServer implements TransportServer {
  readonly transport = "mcp";
  readonly address = "stdio";

  private readonly options: McpServerOptions;
  private transportInstance: StdioServerTransport | null = null;

  constructor(private readonly rig: Rig, options: McpServerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    const server = buildMcpServer(this.rig, this.options);
    this.transportInstance = new StdioServerTransport();
    await server.connect(this.transportInstance);
  }

  async stop(): Promise<void> {
    await this.transportInstance?.close();
  }
}

export function mcpServer(opts?: McpServerOptions): ServerResolver {
  return {
    transport: "mcp",
    create(rig: Rig, _composition?: ServerComposition): TransportServer {
      return new McpTransportServer(rig, opts ?? {});
    },
  };
}
