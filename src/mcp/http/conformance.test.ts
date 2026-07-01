/**
 * MCP-over-HTTP transport conformance — `mcpHttpApi(stubRig)` on a real
 * `Deno.serve` port, exercised through the SDK's
 * `StreamableHTTPClientTransport`. Drives the shared `mcpSpec` so the
 * over-the-wire transport asserts the same tool surface as the in-memory
 * one. Plug in `_conformance/plug.ts`.
 */

/// <reference lib="deno.ns" />

import { runMcpPlug } from "../../../tests/suites/mcp-plug.ts";
import { mcpHttpPlug } from "./_conformance/plug.ts";

runMcpPlug(mcpHttpPlug);
