/**
 * @module
 * `httpNdjson` — streaming-friendly HTTP batch codec. One slot per NDJSON
 * line on the read response; receive body is paired URL-list-plus-NDJSON-
 * payloads.
 *
 * Wire shape:
 *   - **read response:** `application/x-ndjson`. Each line is a JSON object
 *     `{ "uri": "...", "payload": <value> }`. `Uint8Array` payloads are
 *     tagged as `{ "$bytes": "<base64>" }` before JSON.stringify so the
 *     lossy `{0:n,…}` numeric-index shape never appears on the wire; the
 *     decode side reverses the tag back to `Uint8Array`.
 *   - **receive body:** same NDJSON format — one `{ uri, payload }` object
 *     per line.
 *
 * Stream payloads are materialized to `Uint8Array` before line-encoding.
 * NDJSON is line-oriented, not chunked — a `ReadableStream` can't be
 * represented as a single JSON value, so materialization is the correct
 * semantic choice at this layer.
 *
 * Materialization runs through a `Scheduler` (default `Promise.all`).
 * Hosts that need fan-out caps inject one at construction:
 * `httpNdjson({ scheduler: pLimitTo4 })`.
 *
 * The dispatcher's per-request `AbortSignal` flows into the stream pump
 * via `pipeTo({ signal })`, so an aborted request cancels stream
 * consumption at chunk boundaries.
 */

import type { Output } from "@bandeira-tech/b3nd-core/types";
import type { HttpBatchCodec } from "../../http/codec.ts";
import { defaultScheduler, type Scheduler } from "../scheduler.ts";
import { materializeStreams } from "../materialize.ts";

export interface HttpNdjsonOptions {
  /** Fan-out scheduler for per-slot stream materialization. Defaults to `Promise.all`. */
  scheduler?: Scheduler;
}

export function httpNdjson(opts: HttpNdjsonOptions = {}): HttpBatchCodec {
  const scheduler = opts.scheduler ?? defaultScheduler;
  return {
    async encode(outputs, ctx): Promise<Response> {
      const concrete = await materializeStreams(outputs, scheduler, ctx.signal);
      const enc = new TextEncoder();
      const lines = concrete
        .map(([uri, payload]) =>
          JSON.stringify({ uri, payload: shapeForNdjson(payload) }) + "\n"
        )
        .join("");
      return new Response(enc.encode(lines) as unknown as BodyInit, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      });
    },

    async decode(req): Promise<Output[]> {
      const text = await req.text();
      return parseNdjson(text);
    },

    async decodeReadResponse(res): Promise<Output[]> {
      const text = await res.text();
      return parseNdjson(text);
    },
  };
}

// ---------------------------------------------------------------------------
// Payload shaping helpers
// ---------------------------------------------------------------------------

/**
 * Shapes a payload for NDJSON serialization. `Uint8Array` is tagged as
 * `{ "$bytes": "<base64>" }` to survive JSON round-trip byte-faithfully.
 * Everything else passes through unchanged.
 */
function shapeForNdjson(payload: unknown): unknown {
  if (payload instanceof Uint8Array) {
    return { "$bytes": base64FromBytes(payload) };
  }
  return payload;
}

/**
 * Reverses the `$bytes` tag back to `Uint8Array`. A tagged object is
 * distinguished by having exactly one key, `$bytes`, whose value is a
 * string. All other values pass through unchanged.
 */
function reshapeFromNdjson(payload: unknown): unknown {
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

// ---------------------------------------------------------------------------
// NDJSON parse
// ---------------------------------------------------------------------------

function parseNdjson(text: string): Output[] {
  const out: Output[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const obj = JSON.parse(trimmed) as { uri: string; payload: unknown };
    out.push([obj.uri, reshapeFromNdjson(obj.payload)]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Base64 helpers (inline — Task 10 will extract to src/codecs/base64.ts
// when it becomes the second consumer of these helpers)
// ---------------------------------------------------------------------------

function base64FromBytes(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
}

function bytesFromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
