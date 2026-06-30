/**
 * @module
 * Batch codec contract for MCP tool call read + receive responses.
 *
 * MCP's wire surface is the `CallToolResult` content array and the
 * `resources/read` contents array. The codec owns the shape of those
 * arrays; the route owns JSON-RPC framing and method dispatch.
 *
 * ## Route ↔ codec split
 *
 * The codec owns content construction and stream materialization. The route
 * owns argument extraction from JSON-RPC params and `isError` flags.
 *
 *   b3nd_read tool:     server decodes args      → string[]
 *                       server encodes Output[]   → McpContent[]
 *   b3nd_receive tool:  server decodes args      → Output[]
 *                       server encodes results   → McpContent[]
 *   resources/read:     server encodes one Output → McpResourceContent[]
 *
 * Client-side inverses parse the returned content arrays back into
 * domain types.
 *
 * ## encodeReceive shape
 *
 * MCP's receive response includes the original input URI per slot (so the
 * caller can correlate results without a separate lookup). Because
 * `ReceiveResult` does not carry the URI, `encodeReceive` takes both
 * `results` and the original `outputs` so it can render `{ uri, accepted,
 * error }` per slot — preserving today's exact wire shape.
 *
 * ## Why 7 methods (not 8)
 *
 * Other transports (WS, gRPC) have 8 methods because they include
 * client-side request encoders (`encodeReadRequest`, `encodeReceiveRequest`).
 * For MCP the client just calls `{ name: "b3nd_read", arguments: { urls } }`
 * — the tool input schema is fixed by the MCP spec, not by the codec.
 * Adding identity-ish `encodeReadRequest(urls) => { urls }` methods would
 * be pure noise. 7 methods is the correct count for MCP.
 */

import type { Output, ReceiveResult } from "@bandeira-tech/b3nd-core/types";

// ── MCP content item types ────────────────────────────────────────────────

/** MCP text content item — minimum subset of the SDK type. */
export interface McpTextContent {
  type: "text";
  text: string;
}

/** MCP image content item. */
export interface McpImageContent {
  type: "image";
  /** Base64-encoded image data. */
  data: string;
  mimeType: string;
}

/** MCP embedded resource content item. */
export interface McpResourceContent {
  type: "resource";
  resource: {
    uri: string;
    text?: string;
    blob?: string;
    mimeType?: string;
  };
}

/** Union of all MCP content item types. */
export type McpContent = McpTextContent | McpImageContent | McpResourceContent;

// ── Context ───────────────────────────────────────────────────────────────

/** Encode-time context handed to `encodeRead`, `encodeReceive`, and `encodeReadResource`. */
export interface McpEncodeCtx {
  /**
   * Per-request abort signal from the MCP dispatcher. Wired into
   * `materializeStreams` so an aborted request cancels stream pumping at
   * chunk boundaries.
   */
  signal: AbortSignal;
}

// ── Codec interface ───────────────────────────────────────────────────────

/**
 * Batch codec contract for MCP b3nd_read, b3nd_receive, and resources/read.
 *
 * Seven methods — server-side encode/decode for each surface, plus
 * client-side response decoders. No client-side request encoders: MCP
 * tool inputs are fixed by the tool schema, not the codec.
 *
 * Implement this interface to swap the MCP response representation
 * without touching any route or dispatcher code. In v1 exactly one
 * implementation ships: `mcpTextJsonStringify`
 * (see `src/codecs/mcp/text-json-stringify.ts`).
 */
export interface McpBatchCodec {
  // ── Server-side: b3nd_read tool ──────────────────────────────────────

  /**
   * Server: encode `Output[]` (from `rig.read`) into `CallToolResult.content`.
   * Implementations must materialize any `ReadableStream<Uint8Array>` payloads
   * to concrete values before serializing.
   */
  encodeRead(
    outputs: Output[],
    ctx: McpEncodeCtx,
  ): McpContent[] | Promise<McpContent[]>;

  /**
   * Server: extract the `urls` string array from raw `b3nd_read` tool
   * arguments. Throws `TypeError` on invalid shape.
   */
  decodeReadArgs(args: unknown): string[];

  // ── Server-side: b3nd_receive tool ───────────────────────────────────

  /**
   * Server: encode `ReceiveResult[]` into `CallToolResult.content`.
   *
   * Takes BOTH `results` and the original `outputs` so the response can
   * include the input URI per slot — preserving today's
   * `{ uri, accepted, error }` shape exactly. `outputs[i][0]` is the URI
   * for `results[i]`.
   */
  encodeReceive(
    results: ReceiveResult[],
    outputs: Output[],
    ctx: McpEncodeCtx,
  ): McpContent[] | Promise<McpContent[]>;

  /**
   * Server: extract the `Output[]` from raw `b3nd_receive` tool arguments.
   * Throws `TypeError` on invalid shape.
   */
  decodeReceiveArgs(args: unknown): Output[];

  // ── Server-side: resources/read ──────────────────────────────────────

  /**
   * Server: encode a single `Output` into the `contents` array for a
   * `resources/read` response. `resourceUri` is the original `b3nd://…`
   * URI the client requested.
   */
  encodeReadResource(
    output: Output,
    resourceUri: string,
    ctx: McpEncodeCtx,
  ): McpResourceContent[] | Promise<McpResourceContent[]>;

  // ── Client-side: response decoders ───────────────────────────────────

  /**
   * Client: parse a `b3nd_read` `CallToolResult.content` array into `Output[]`.
   * Inverse of `encodeRead`.
   */
  decodeReadResponse(content: McpContent[]): Output[];

  /**
   * Client: parse a `b3nd_receive` `CallToolResult.content` array into
   * `ReceiveResult[]`. Inverse of `encodeReceive` (URI is dropped; only
   * `accepted` and `error` survive into `ReceiveResult`).
   */
  decodeReceiveResponse(content: McpContent[]): ReceiveResult[];
}
