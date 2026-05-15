/**
 * MCP — in-Deno integration: real `buildMcpServer` linked to a real
 * SDK `Client` over `InMemoryTransport`, against an in-process Map-
 * backed rig. Drives the shared `mcpSpec` tool-surface suite.
 */

/// <reference lib="deno.ns" />

import { mcpSpec } from "../../suites/mcp-spec.ts";
import { startMcpInProcess } from "../../factories/mcp.ts";
import { testRig } from "../../rigs/memory.ts";

mcpSpec("mcp", () => startMcpInProcess(testRig()));
