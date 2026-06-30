/**
 * @module
 * `mcpResourcePerSlot` — byte-faithful, idiomatic MCP codec.
 *
 * Packages each Output slot as a dedicated `ResourceContent` item so the
 * MCP caller gets one `resources/read`-style entry per slot rather than a
 * single JSON blob. Byte payloads go to `blob` (base64), strings to `text`
 * with `text/plain`, and objects are `JSON.stringify`d to `text` with
 * `application/json`. This gives full byte fidelity — unlike
 * `mcpTextJsonStringify`, which loses binary data after JSON.stringify.
 *
 * ## Wire shape
 *
 * **b3nd_read tool response** (`CallToolResult.content`):
 *   One `{ type: "resource", resource: { uri, blob | text, mimeType } }` per slot.
 *   - `Uint8Array` → `blob: base64(bytes)`, `mimeType: "application/octet-stream"`
 *   - `string`     → `text: payload`,      `mimeType: "text/plain"`
 *   - `null/undefined/object` → `text: JSON.stringify(payload)`, `mimeType: "application/json"`
 *
 * **b3nd_receive tool response** (`CallToolResult.content`):
 *   One ResourceContent per slot; `text` holds `JSON.stringify({ accepted, error? })`,
 *   `mimeType: "application/json"`. URI from `outputs[i][0]` is included in the
 *   resource uri for human-readable correlation.
 *
 * **resources/read response** (`contents`):
 *   Single-element array; same payload-shape branching as encodeRead, but
 *   `resource.uri = resourceUri` (the caller-supplied `b3nd://` form).
 *
 * ## Scheduler
 *
 * Stream materialization runs through a `Scheduler` (default `Promise.all`).
 * Hosts that need fan-out caps inject one at construction:
 * `mcpResourcePerSlot({ scheduler: pLimitTo4 })`.
 */

import type { Output, ReceiveResult } from "@bandeira-tech/b3nd-core/types";
import type {
  McpBatchCodec,
  McpContent,
  McpEncodeCtx,
  McpResourceContent,
} from "../../mcp/codec.ts";
import { base64FromBytes, bytesFromBase64 } from "../base64.ts";
import { materializeStreams } from "../materialize.ts";
import { defaultScheduler, type Scheduler } from "../scheduler.ts";

export interface McpResourcePerSlotOptions {
  /** Fan-out scheduler for per-slot stream materialization. Defaults to `Promise.all`. */
  scheduler?: Scheduler;
}

/**
 * Build a `ResourceContent` for a single concrete (non-stream) payload.
 * Dispatches on type: Uint8Array → blob, string → text/plain, else → JSON text.
 */
function buildResourceContent(
  uri: string,
  payload: unknown,
): McpResourceContent {
  if (payload instanceof Uint8Array) {
    return {
      type: "resource",
      resource: {
        uri,
        blob: base64FromBytes(payload),
        mimeType: "application/octet-stream",
      },
    };
  }
  if (typeof payload === "string") {
    return {
      type: "resource",
      resource: {
        uri,
        text: payload,
        mimeType: "text/plain",
      },
    };
  }
  // null, undefined, object — JSON.stringify handles null → "null"
  return {
    type: "resource",
    resource: {
      uri,
      text: JSON.stringify(payload),
      mimeType: "application/json",
    },
  };
}

/**
 * Returns a `McpBatchCodec` that produces one `ResourceContent` per slot,
 * preserving byte fidelity via base64 `blob` for `Uint8Array` payloads.
 *
 * @param opts.scheduler  Fan-out policy for stream materialization.
 *   Defaults to `Promise.all`. Inject a semaphore or token-bucket
 *   scheduler to cap concurrency without changing the codec contract.
 */
export function mcpResourcePerSlot(
  opts: McpResourcePerSlotOptions = {},
): McpBatchCodec {
  const scheduler = opts.scheduler ?? defaultScheduler;

  return {
    /**
     * Server: materialize any `ReadableStream<Uint8Array>` slot payloads to
     * concrete values, then produce one `ResourceContent` per slot.
     *
     * Bytes → blob (base64, `application/octet-stream`).
     * Strings → text (`text/plain`).
     * Objects/null → JSON.stringify text (`application/json`).
     */
    async encodeRead(
      outputs: Output[],
      ctx: McpEncodeCtx,
    ): Promise<McpContent[]> {
      const concrete = await materializeStreams(outputs, scheduler, ctx.signal);
      return concrete.map(([uri, payload]) =>
        buildResourceContent(uri, payload)
      );
    },

    /**
     * Server: produce one `ResourceContent` per slot with
     * `text: JSON.stringify({ accepted, error? })` and `mimeType: "application/json"`.
     * The URI from `outputs[i][0]` is set on `resource.uri` for human-readable correlation.
     */
    encodeReceive(
      results: ReceiveResult[],
      outputs: Output[],
      _ctx: McpEncodeCtx,
    ): McpContent[] {
      return results.map((r, i): McpResourceContent => ({
        type: "resource",
        resource: {
          uri: outputs[i][0],
          text: JSON.stringify({
            accepted: r.accepted,
            ...(r.error !== undefined ? { error: r.error } : {}),
          }),
          mimeType: "application/json",
        },
      }));
    },

    /**
     * Server: materialize the single Output and produce a single `ResourceContent`
     * using `resourceUri` (the caller's `b3nd://` URI, not the output's own URI).
     * Same payload-shape branching as `encodeRead`.
     */
    async encodeReadResource(
      output: Output,
      resourceUri: string,
      ctx: McpEncodeCtx,
    ): Promise<McpResourceContent[]> {
      const [concrete] = await materializeStreams(
        [output],
        scheduler,
        ctx.signal,
      );
      const [, payload] = concrete;
      return [buildResourceContent(resourceUri, payload)];
    },

    /**
     * Server: extract and validate `{ urls: string[] }` from the raw
     * `b3nd_read` tool arguments. Throws `TypeError` on invalid shape.
     */
    decodeReadArgs(args: unknown): string[] {
      const urls = (args as { urls?: unknown } | null)?.urls;
      if (
        !Array.isArray(urls) ||
        !urls.every((u): u is string => typeof u === "string")
      ) {
        throw new TypeError(
          "mcpResourcePerSlot.decodeReadArgs: expected { urls: string[] }",
        );
      }
      return urls;
    },

    /**
     * Server: extract the `messages` array from the raw `b3nd_receive` tool
     * arguments. Throws `TypeError` on invalid shape.
     */
    decodeReceiveArgs(args: unknown): Output[] {
      const messages = (args as { messages?: unknown } | null)?.messages;
      if (!Array.isArray(messages)) {
        throw new TypeError(
          "mcpResourcePerSlot.decodeReceiveArgs: expected { messages: Output[] }",
        );
      }
      return messages as Output[];
    },

    /**
     * Client: parse a `b3nd_read` `CallToolResult.content` array of
     * `ResourceContent` items into `Output[]`.
     *
     * Per-slot reversal:
     * - `blob` present → `Uint8Array` via `bytesFromBase64`
     * - `mimeType === "application/json" && text` → `JSON.parse(text)`
     * - `text` (non-json mimeType) → string as-is
     * - else → null
     */
    decodeReadResponse(content: McpContent[]): Output[] {
      return content
        .filter((c): c is McpResourceContent => c.type === "resource")
        .map((c): Output => {
          const { uri, blob, text, mimeType } = c.resource;
          if (blob !== undefined) {
            return [uri, bytesFromBase64(blob)];
          }
          if (mimeType === "application/json" && text !== undefined) {
            return [uri, JSON.parse(text)];
          }
          if (text !== undefined) {
            return [uri, text];
          }
          return [uri, null];
        });
    },

    /**
     * Client: parse a `b3nd_receive` `CallToolResult.content` array of
     * `ResourceContent` items into `ReceiveResult[]`.
     *
     * Each item's `resource.text` is `JSON.parse`d as `{ accepted, error? }`.
     * The URI is dropped — `ReceiveResult` does not carry it.
     */
    decodeReceiveResponse(content: McpContent[]): ReceiveResult[] {
      return content
        .filter((c): c is McpResourceContent => c.type === "resource")
        .map((c): ReceiveResult => {
          const parsed = JSON.parse(c.resource.text ?? "{}") as {
            accepted: boolean;
            error?: string;
          };
          return {
            accepted: parsed.accepted,
            ...(parsed.error !== undefined ? { error: parsed.error } : {}),
          };
        });
    },
  };
}
