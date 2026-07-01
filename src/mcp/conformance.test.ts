/**
 * In-process MCP transport conformance — real `buildMcpServer` linked to
 * a real SDK `Client` over `InMemoryTransport`, against `stubRig`. Drives
 * the shared `mcpSpec` tool-surface suite. Plug in `_conformance/plug.ts`.
 */

/// <reference lib="deno.ns" />

import { runMcpPlug } from "../../tests/suites/mcp-plug.ts";
import { mcpInProcessPlug } from "./_conformance/plug.ts";

runMcpPlug(mcpInProcessPlug);
