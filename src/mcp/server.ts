/**
 * @module
 * MCP (Model Context Protocol) server bound to stdio.
 *
 * Wraps a `Rig` as an MCP server connected over stdio, exposing B3nd
 * data operations and crypto utilities as MCP tools.
 *
 * @example
 * ```typescript
 * import { mcpServer } from "@bandeira-tech/b3nd-move/mcp/server";
 *
 * const server = mcpServer(rig);
 * await server.start(); // blocks on stdio
 * ```
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Rig } from "@bandeira-tech/b3nd-core";
import { buildMcpServer, type McpServerOptions } from "./service.ts";

export interface TransportServer {
  readonly transport: string;
  readonly address: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

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

export function mcpServer(
  rig: Rig,
  opts?: McpServerOptions,
): TransportServer {
  return new McpTransportServer(rig, opts ?? {});
}
