/**
 * MCP — in-Deno integration: real `buildMcpServer` linked to a real
 * SDK `Client` over `InMemoryTransport`, against a `MemoryStore`-
 * backed rig. Drives the shared `mcpSpec` tool-surface suite.
 */

/// <reference lib="deno.ns" />

import { mcpSpec } from "../../suites/mcp-spec.ts";
import { startMcpInProcess } from "../../factories/mcp.ts";
import { memoryRig } from "../../rigs/memory.ts";

mcpSpec("mcp", () => startMcpInProcess(memoryRig()));
