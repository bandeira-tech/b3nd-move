/**
 * MCP-over-HTTP — in-Deno integration: `mcpHttpApi(stubRig)` mounted on
 * a real `Deno.serve` port, exercised through the SDK's
 * `StreamableHTTPClientTransport`. Drives the shared `mcpSpec` suite so
 * the over-the-wire transport asserts the same tool surface as the
 * in-memory one.
 */

/// <reference lib="deno.ns" />

import { mcpSpec } from "../../suites/mcp-spec.ts";
import { startMcpOverHttp } from "../../factories/mcp-http.ts";
import { stubRig } from "../../rigs/stub.ts";

mcpSpec("mcp-http", () => startMcpOverHttp(stubRig()));
