/**
 * MCP — in-Deno integration: real `buildMcpServer` linked to a real
 * SDK `Client` over `InMemoryTransport`, against the stub rig.
 * Drives the shared `mcpSpec` per-operation suite.
 */

/// <reference lib="deno.ns" />

import { mcpSpec } from "../../suites/mcp-spec.ts";
import { startMcpInProcess } from "../../factories/mcp.ts";
import { stubRig } from "../../rig.ts";

mcpSpec("mcp", () => startMcpInProcess(stubRig()));
