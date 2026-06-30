/**
 * @module
 * `mcpTextJsonStringify` — today's baked MCP behavior, made explicit.
 *
 * Packages the default MCP read/receive codec as an operator-declared
 * value. Today the MCP service hardcodes its encode logic inline in
 * `src/mcp/service.ts`; this codec captures that exact behavior so
 * Task 14 can wire it in and make the seam configurable without changing
 * any observable wire behavior.
 *
 * ## Wire shape
 *
 * **b3nd_read tool response** (`CallToolResult.content`):
 *   `[{ type: "text", text: JSON.stringify(outputs.map(([uri, payload]) => ({ uri, payload })), null, 2) }]`
 *   Stream payloads are materialized to `Uint8Array` before stringify,
 *   which means bytes emerge as the lossy `{"0":n,"1":n,…}` shape
 *   (documented KNOWN LIMITATION — consistent with today's service).
 *
 * **b3nd_receive tool response** (`CallToolResult.content`):
 *   `[{ type: "text", text: JSON.stringify(results.map((r, i) => ({ uri: outputs[i][0], accepted: r.accepted, error: r.error })), null, 2) }]`
 *
 * **resources/read response** (`contents`):
 *   `[{ type: "resource", resource: { uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) } }]`
 *
 * ## Scheduler
 *
 * Stream materialization runs through a `Scheduler` (default `Promise.all`).
 * Hosts that need fan-out caps inject one at construction:
 * `mcpTextJsonStringify({ scheduler: pLimitTo4 })`.
 */

import type { Output, ReceiveResult } from "@bandeira-tech/b3nd-core/types";
import type {
  McpBatchCodec,
  McpContent,
  McpEncodeCtx,
  McpResourceContent,
  McpTextContent,
} from "../../mcp/codec.ts";
import { materializeStreams } from "../materialize.ts";
import { defaultScheduler, type Scheduler } from "../scheduler.ts";

export interface McpTextJsonStringifyOptions {
  /** Fan-out scheduler for per-slot stream materialization. Defaults to `Promise.all`. */
  scheduler?: Scheduler;
}

/**
 * Returns a `McpBatchCodec` that replicates today's baked MCP behavior.
 *
 * @param opts.scheduler  Fan-out policy for stream materialization.
 *   Defaults to `Promise.all`. Inject a semaphore or token-bucket
 *   scheduler to cap concurrency without changing the codec contract.
 */
export function mcpTextJsonStringify(
  opts: McpTextJsonStringifyOptions = {},
): McpBatchCodec {
  const scheduler = opts.scheduler ?? defaultScheduler;

  return {
    /**
     * Server: materialize any `ReadableStream<Uint8Array>` slot payloads to
     * concrete values, then produce a single TextContent with a
     * `JSON.stringify(..., null, 2)` of `[{uri, payload}, ...]`.
     *
     * Bytes emerge as the lossy `{"0":n,"1":n,…}` shape after JSON.stringify
     * (KNOWN LIMITATION — consistent with today's baked service behavior).
     */
    async encodeRead(
      outputs: Output[],
      ctx: McpEncodeCtx,
    ): Promise<McpContent[]> {
      const concrete = await materializeStreams(outputs, scheduler, ctx.signal);
      const text: McpTextContent = {
        type: "text",
        text: JSON.stringify(
          concrete.map(([uri, payload]) => ({ uri, payload })),
          null,
          2,
        ),
      };
      return [text];
    },

    /**
     * Server: produce a single TextContent with `JSON.stringify(..., null, 2)`
     * of `[{uri, accepted, error}, ...]`. The URI comes from `outputs[i][0]`
     * since `ReceiveResult` does not carry the URI.
     */
    encodeReceive(
      results: ReceiveResult[],
      outputs: Output[],
      _ctx: McpEncodeCtx,
    ): McpContent[] {
      const text: McpTextContent = {
        type: "text",
        text: JSON.stringify(
          results.map((r, i) => ({
            uri: outputs[i][0],
            accepted: r.accepted,
            ...(r.error !== undefined ? { error: r.error } : {}),
          })),
          null,
          2,
        ),
      };
      return [text];
    },

    /**
     * Server: materialize the single Output and produce a `ResourceContent`
     * with `mimeType: "application/json"` and `text: JSON.stringify(payload, null, 2)`.
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
      const item: McpResourceContent = {
        type: "resource",
        resource: {
          uri: resourceUri,
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2),
        },
      };
      return [item];
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
          "mcpTextJsonStringify.decodeReadArgs: expected { urls: string[] }",
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
          "mcpTextJsonStringify.decodeReceiveArgs: expected { messages: Output[] }",
        );
      }
      return messages as Output[];
    },

    /**
     * Client: parse the first TextContent item from a `b3nd_read`
     * `CallToolResult.content` array into `Output[]`.
     *
     * The text is `JSON.stringify`d `[{uri, payload}, ...]`; we reconstruct
     * `[uri, payload]` tuples. Defaults to `[]` if no text item found.
     */
    decodeReadResponse(content: McpContent[]): Output[] {
      const textItem = content.find(
        (c): c is McpTextContent => c.type === "text",
      );
      if (!textItem) return [];
      const parsed = JSON.parse(textItem.text) as Array<{
        uri: string;
        payload: unknown;
      }>;
      return parsed.map((o) => [o.uri, o.payload] as Output);
    },

    /**
     * Client: parse the first TextContent item from a `b3nd_receive`
     * `CallToolResult.content` array into `ReceiveResult[]`.
     *
     * The URI field in the response is dropped — `ReceiveResult` only
     * carries `accepted` and optionally `error`.
     */
    decodeReceiveResponse(content: McpContent[]): ReceiveResult[] {
      const textItem = content.find(
        (c): c is McpTextContent => c.type === "text",
      );
      if (!textItem) return [];
      const parsed = JSON.parse(textItem.text) as Array<{
        uri: string;
        accepted: boolean;
        error?: string;
      }>;
      return parsed.map((r): ReceiveResult => ({
        accepted: r.accepted,
        ...(r.error !== undefined ? { error: r.error } : {}),
      }));
    },
  };
}
