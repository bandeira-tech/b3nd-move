/**
 * @module
 * Converters between b3nd core types and proto wire types.
 *
 * Payload encoding:
 * - Uint8Array → raw bytes, flagged `payloadIsBinary: true`
 * - anything else → UTF-8 JSON bytes (handled transparently by
 *   @bufbuild/protobuf — base64 in JSON transport, raw in binary)
 *
 * A payload `JSON.stringify` cannot represent (`undefined`, a function, a
 * symbol) encodes as the `null` miss sentinel, and a zero-length non-binary
 * payload decodes back to `null` — the same normalization
 * `../../codecs/outputs-frame.ts` applies, so a miss reads identically over
 * gRPC and HTTP. See `tests/rigs/stub.ts` for why `null` is the sentinel.
 */

import { create } from "@bufbuild/protobuf";
import type {
  Output,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core";
import {
  OutputProtoSchema,
  ReceiveResultProtoSchema,
  StatusResponseSchema,
} from "./gen/b3nd_pb.ts";
import type {
  OutputProto,
  ReceiveResultProto,
  StatusResponse,
} from "./gen/b3nd_pb.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function encodePayload(
  payload: unknown,
): { payload: Uint8Array; payloadIsBinary: boolean } {
  if (payload instanceof Uint8Array) return { payload, payloadIsBinary: true };
  return {
    payload: enc.encode(JSON.stringify(payload) ?? "null"),
    payloadIsBinary: false,
  };
}

function decodePayload(bytes: Uint8Array, isBinary: boolean): unknown {
  if (isBinary) return bytes;
  const json = dec.decode(bytes);
  return json.length > 0 ? JSON.parse(json) : null;
}

// ── Output ↔ OutputProto ─────────────────────────────────────────────────

export function outputToProto<T>(out: Output<T>): OutputProto {
  const [uri, payload] = out;
  const enc = encodePayload(payload);
  return create(OutputProtoSchema, {
    uri,
    payload: enc.payload,
    payloadIsBinary: enc.payloadIsBinary,
  });
}

export function outputFromProto<T = unknown>(p: OutputProto): Output<T> {
  return [p.uri, decodePayload(p.payload, p.payloadIsBinary) as T];
}

// ── ReceiveResult ↔ ReceiveResultProto ──────────────────────────────────

export function receiveResultToProto(r: ReceiveResult): ReceiveResultProto {
  return create(ReceiveResultProtoSchema, {
    accepted: r.accepted,
    error: r.error ?? "",
  });
}

export function receiveResultFromProto(r: ReceiveResultProto): ReceiveResult {
  return { accepted: r.accepted, ...(r.error ? { error: r.error } : {}) };
}

// ── StatusResult ↔ StatusResponse ────────────────────────────────────────

export function statusResultToResponse(r: StatusResult): StatusResponse {
  return create(StatusResponseSchema, {
    status: r.status,
    message: r.message ?? "",
    schemaJson: r.schema ? JSON.stringify(r.schema) : "",
    fnsJson: r.fns ? JSON.stringify(r.fns) : "",
    detailsJson: r.details ? JSON.stringify(r.details) : "",
  });
}

export function statusResponseToResult(r: StatusResponse): StatusResult {
  return {
    status: r.status as StatusResult["status"],
    ...(r.message ? { message: r.message } : {}),
    ...(r.schemaJson ? { schema: JSON.parse(r.schemaJson) as string[] } : {}),
    ...(r.fnsJson ? { fns: JSON.parse(r.fnsJson) as string[] } : {}),
    ...(r.detailsJson
      ? { details: JSON.parse(r.detailsJson) as Record<string, unknown> }
      : {}),
  };
}
