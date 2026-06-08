/**
 * MCP-over-WS — in-Deno integration: `mcpWsApi(stubRig)` mounted on a
 * real `Deno.serve` port, exercised through the SDK's
 * `WebSocketClientTransport`. Drives the shared `mcpSpec` suite so the
 * WS transport asserts the same tool surface as the other MCP
 * transports.
 */

/// <reference lib="deno.ns" />

import { mcpSpec } from "../../suites/mcp-spec.ts";
import { startMcpOverWs } from "../../factories/mcp-ws.ts";
import { stubRig } from "../../rigs/stub.ts";

mcpSpec("mcp-ws", () => startMcpOverWs(stubRig()));
