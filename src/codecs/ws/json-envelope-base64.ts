/**
 * @module
 * `wsJsonEnvelopeBase64` — byte-faithful WS batch codec (M1 fix).
 *
 * Same shape as `wsJsonEnvelope` but `Uint8Array` payloads in the read
 * direction are wrapped as `{ "$bytes": "<base64>" }` tagged objects before
 * `JSON.stringify`, so they round-trip byte-faithful through the wire.
 * The decode side (`decodeReadResponse`) reverses the tag back to `Uint8Array`.
 *
 * ## Wire shape
 *
 * **Server → client (read)**:
 *   `{ id, success: true, data: Output[] }` where `Uint8Array` payload slots
 *   appear as `{ "$bytes": "<base64>" }` instead of the lossy `{0:n,…}` shape
 *   that `JSON.stringify(uint8Array)` produces. Stream payloads are
 *   materialized first, then tagged.
 *
 * **All other shapes**: identical to `wsJsonEnvelope`.
 *
 * ## Codec coverage
 *
 * Only the READ direction is byte-faithful. The RECEIVE direction (client →
 * server) is unchanged from `wsJsonEnvelope` — the producer controls
 * encoding on the inbound path; this codec does not transform on the way in.
 *
 * ## PR#50 M1 fix
 *
 * This codec resolves the documented KNOWN LIMITATION in `wsJsonEnvelope`
 * ("Uint8Array payloads emerge as `{0:n,…}`"). Operators opt in by wiring
 * `wsJsonEnvelopeBase64()` instead of `wsJsonEnvelope()`.
 */

import type { Output, ReceiveResult } from "@bandeira-tech/b3nd-core/types";
import type { WsBatchCodec } from "../../ws/codec.ts";
import { validateOutputs, validateUrls } from "../../actions/validate.ts";
import { defaultScheduler, type Scheduler } from "../scheduler.ts";
import { materializeStreams } from "../materialize.ts";
import { base64FromBytes, bytesFromBase64 } from "../base64.ts";

export interface WsJsonEnvelopeBase64Options {
  /** Fan-out scheduler for per-slot stream materialization. Defaults to `Promise.all`. */
  scheduler?: Scheduler;
}

/**
 * Returns a `WsBatchCodec` that is byte-faithful for `Uint8Array` payloads.
 *
 * `encodeRead` materializes `ReadableStream` payloads and wraps any
 * `Uint8Array` slot as `{ "$bytes": "<base64>" }` before the WS service
 * JSON-serializes the envelope. `decodeReadResponse` reverses the tag.
 *
 * All other methods are identical to `wsJsonEnvelope`.
 *
 * @param opts.scheduler  Fan-out policy for stream materialization.
 *   Defaults to `Promise.all`.
 */
export function wsJsonEnvelopeBase64(
  opts: WsJsonEnvelopeBase64Options = {},
): WsBatchCodec {
  const scheduler = opts.scheduler ?? defaultScheduler;

  return {
    /**
     * Server: materialize any `ReadableStream<Uint8Array>` slot payloads
     * to concrete `Uint8Array` values, then tag each `Uint8Array` as
     * `{ "$bytes": "<base64>" }` so the WS service's `JSON.stringify` does
     * not produce the lossy `{0:n,…}` numeric-index shape.
     */
    async encodeRead(outputs, ctx): Promise<Output[]> {
      const concrete = await materializeStreams(outputs, scheduler, ctx.signal);
      return concrete.map(([uri, payload]) => [uri, tagBytesPayload(payload)]);
    },

    /**
     * Server: return `results` unchanged. `ReceiveResult[]` is already
     * JSON-serializable; no transformation needed.
     */
    encodeReceive(results, _ctx): ReceiveResult[] {
      return results;
    },

    /**
     * Server: extract and validate `{ urls: string[] }` from the inbound
     * WS read payload. Throws `TypeError` on invalid shape.
     */
    decodeRead(payload): string[] {
      const urls = (payload as { urls?: unknown } | null)?.urls;
      const v = validateUrls(urls);
      if (!v.ok) throw new TypeError(v.error);
      return v.value;
    },

    /**
     * Server: validate the inbound WS receive payload as `Output[]`.
     * Throws `TypeError` on invalid shape.
     */
    decodeReceive(payload): Output[] {
      const v = validateOutputs(payload);
      if (!v.ok) throw new TypeError(v.error);
      return v.value;
    },

    /**
     * Client: walk the parsed `data` field and reverse any `{ "$bytes" }`
     * tagged object back to a `Uint8Array`. Non-tagged values pass through.
     */
    decodeReadResponse(data): Output[] {
      const outputs = data as Output[];
      return outputs.map(([uri, payload]) => [uri, untagBytesPayload(payload)]);
    },

    /**
     * Client: return the parsed `data` field as-is (cast to `ReceiveResult[]`).
     */
    decodeReceiveResponse(data): ReceiveResult[] {
      return data as ReceiveResult[];
    },

    /**
     * Client: wrap `urls` in the `{ urls }` shape the WS server expects
     * as the read request payload.
     */
    encodeReadRequest(urls): { urls: string[] } {
      return { urls };
    },

    /**
     * Client: return `outputs` raw. The WS server expects a bare `Output[]`
     * as the receive request payload.
     */
    encodeReceiveRequest(outputs): Output[] {
      return outputs;
    },
  };
}

// ---------------------------------------------------------------------------
// Byte-tagging helpers
// ---------------------------------------------------------------------------

/**
 * If `payload` is a `Uint8Array`, wraps it as `{ "$bytes": "<base64>" }`.
 * All other values pass through unchanged.
 */
function tagBytesPayload(payload: unknown): unknown {
  if (payload instanceof Uint8Array) {
    return { "$bytes": base64FromBytes(payload) };
  }
  return payload;
}

/**
 * If `payload` is a single-key object `{ "$bytes": string }`, decodes the
 * base64 string back to a `Uint8Array`. All other values pass through.
 *
 * The single-key check ensures objects that happen to have a `$bytes` field
 * alongside other fields are not silently coerced.
 */
function untagBytesPayload(payload: unknown): unknown {
  if (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.keys(payload as object).length === 1 &&
    typeof (payload as Record<string, unknown>)["$bytes"] === "string"
  ) {
    return bytesFromBase64((payload as { "$bytes": string })["$bytes"]);
  }
  return payload;
}
