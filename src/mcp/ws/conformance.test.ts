/**
 * MCP-over-WS transport conformance — `mcpWsApi(stubRig)` on a real
 * `Deno.serve` port, exercised through the SDK's
 * `WebSocketClientTransport`. Drives the shared `mcpSpec` so the WS
 * transport asserts the same tool surface as the other MCP transports.
 * Plug in `_conformance/plug.ts`.
 */

/// <reference lib="deno.ns" />

import { runMcpPlug } from "../../../tests/suites/mcp-plug.ts";
import { mcpWsPlug } from "./_conformance/plug.ts";

runMcpPlug(mcpWsPlug);
