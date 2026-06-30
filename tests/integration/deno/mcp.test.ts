/**
 * MCP — in-Deno integration: real `buildMcpServer` linked to a real
 * SDK `Client` over `InMemoryTransport`, against `stubRig` (canned
 * responses). Drives the shared `mcpSpec` tool-surface suite to assert
 * the b3nd tool surface decodes the rig's responses faithfully.
 */

/// <reference lib="deno.ns" />

import { mcpSpec } from "../../suites/mcp-spec.ts";
import { startMcpInProcess } from "../../factories/mcp.ts";
import { stubRig } from "../../rigs/stub.ts";
import { mcpTextJsonStringify } from "../../../src/codecs/mcp/mod.ts";

mcpSpec(
  "mcp",
  () => startMcpInProcess(stubRig(), { codec: mcpTextJsonStringify() }),
);
