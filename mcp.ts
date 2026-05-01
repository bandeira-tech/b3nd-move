/**
 * @module
 * MCP (Model Context Protocol) subpath — server and service for AI tool access.
 *
 * For finer-grained imports:
 *   @bandeira-tech/b3nd-servers/mcp/server — `mcpServer()` resolver (Deno only, stdio)
 *   @bandeira-tech/b3nd-servers/mcp/api    — `buildMcpServer(rig)` (any runtime)
 */

export { mcpServer } from "./libs/b3nd-server-mcp/mod.ts";
export type { McpServerOptions } from "./libs/b3nd-server-mcp/mod.ts";

export { buildMcpServer } from "./libs/b3nd-server-mcp/service.ts";
