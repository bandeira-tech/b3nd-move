/**
 * @module
 * MCP batch codecs catalog. Operators import from here:
 *
 * ```ts
 * import { mcpTextJsonStringify } from "@bandeira-tech/b3nd-move/codecs/mcp";
 * buildMcpServer(rig, { codec: mcpTextJsonStringify() });
 * ```
 *
 * Two codecs ship for MCP: `mcpTextJsonStringify`, which packages the
 * default behavior (one TextContent with `JSON.stringify(..., null, 2)`)
 * and materializes stream payloads before serialization; and
 * `mcpResourcePerSlot`, which wraps each slot as a ResourceContent item
 * with byte-faithful base64 encoding for binary payloads.
 */

export { mcpTextJsonStringify } from "./text-json-stringify.ts";
export type { McpTextJsonStringifyOptions } from "./text-json-stringify.ts";
export { mcpResourcePerSlot } from "./resource-per-slot.ts";
export type { McpResourcePerSlotOptions } from "./resource-per-slot.ts";
