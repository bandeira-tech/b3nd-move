/**
 * @module
 * MCP batch codecs catalog. Operators import from here:
 *
 * ```ts
 * import { mcpTextJsonStringify } from "@bandeira-tech/b3nd-move/codecs/mcp";
 * buildMcpServer(rig, { codec: mcpTextJsonStringify() });
 * ```
 *
 * Only one codec ships for MCP in v1: `mcpTextJsonStringify`, which
 * packages today's baked behavior (one TextContent with
 * `JSON.stringify(..., null, 2)`) and materializes stream payloads before
 * serialization.
 */

export { mcpTextJsonStringify } from "./text-json-stringify.ts";
export type { McpTextJsonStringifyOptions } from "./text-json-stringify.ts";
export { mcpResourcePerSlot } from "./resource-per-slot.ts";
export type { McpResourcePerSlotOptions } from "./resource-per-slot.ts";
