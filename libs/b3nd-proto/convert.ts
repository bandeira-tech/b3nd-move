/**
 * @module
 * Converters between b3nd core types and proto wire types.
 *
 * Payload encoding:
 * - JSON-serializable → UTF-8 JSON bytes stored in `data` (Uint8Array)
 * - Uint8Array → raw bytes, flagged `dataIsBinary: true`
 *
 * The `data` bytes field is handled by @bufbuild/protobuf automatically:
 * - JSON transport: base64-encodes/decodes bytes transparently
 * - Binary transport: passes bytes through as-is
 * No manual base64 handling needed here or in the server/client.
 */

import { create } from "@bufbuild/protobuf";
import type {
  Message,
  ReadResult,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core";
import {
  ReadResultProtoSchema,
  ReceiveRequestSchema,
  ReceiveResponseSchema,
  RecordProtoSchema,
  StatusResponseSchema,
} from "./gen/b3nd_pb.ts";
import type {
  ReadResultProto,
  ReceiveRequest,
  ReceiveResponse,
  RecordProto,
  StatusResponse,
} from "./gen/b3nd_pb.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function encodePayload(payload: unknown): { data: Uint8Array; dataIsBinary: boolean } {
  if (payload instanceof Uint8Array) return { data: payload, dataIsBinary: true };
  return { data: enc.encode(JSON.stringify(payload)), dataIsBinary: false };
}

function decodePayload(data: Uint8Array, isBinary: boolean): unknown {
  if (isBinary) return data;
  const json = dec.decode(data);
  return json.length > 0 ? JSON.parse(json) : undefined;
}

// ── Message ↔ ReceiveRequest ──────────────────────────────────────────────

export function messageToReceiveRequest(msg: Message): ReceiveRequest {
  const [uri, payload] = msg;
  const { data, dataIsBinary } = encodePayload(payload);
  return create(ReceiveRequestSchema, { uri, data, dataIsBinary });
}

export function receiveRequestToMessage(req: ReceiveRequest): Message {
  return [req.uri, decodePayload(req.data, req.dataIsBinary)];
}

// ── ReceiveResult ↔ ReceiveResponse ──────────────────────────────────────

export function receiveResultToResponse(r: ReceiveResult): ReceiveResponse {
  return create(ReceiveResponseSchema, { accepted: r.accepted, error: r.error ?? "" });
}

export function receiveResponseToResult(r: ReceiveResponse): ReceiveResult {
  return { accepted: r.accepted, ...(r.error ? { error: r.error } : {}) };
}

// ── ReadResult ↔ ReadResultProto ─────────────────────────────────────────

export function readResultToProto<T>(r: ReadResult<T>): ReadResultProto {
  let record: RecordProto | undefined;
  if (r.success && r.record) {
    const { data, dataIsBinary } = encodePayload(r.record.data);
    record = create(RecordProtoSchema, { data, dataIsBinary });
  }
  return create(ReadResultProtoSchema, {
    success: r.success,
    uri: r.uri ?? "",
    error: r.error ?? "",
    record,
  });
}

export function readResultFromProto<T = unknown>(p: ReadResultProto): ReadResult<T> {
  if (!p.success) {
    return {
      success: false,
      ...(p.uri ? { uri: p.uri } : {}),
      ...(p.error ? { error: p.error } : {}),
    };
  }
  const record = p.record
    ? { data: decodePayload(p.record.data, p.record.dataIsBinary) as T }
    : undefined;
  return { success: true, ...(p.uri ? { uri: p.uri } : {}), record };
}

// ── StatusResult ↔ StatusResponse ────────────────────────────────────────

export function statusResultToResponse(r: StatusResult): StatusResponse {
  return create(StatusResponseSchema, {
    status: r.status,
    message: r.message ?? "",
    schemaJson: r.schema ? JSON.stringify(r.schema) : "",
    detailsJson: r.details ? JSON.stringify(r.details) : "",
  });
}

export function statusResponseToResult(r: StatusResponse): StatusResult {
  return {
    status: r.status as StatusResult["status"],
    ...(r.message ? { message: r.message } : {}),
    ...(r.schemaJson ? { schema: JSON.parse(r.schemaJson) as string[] } : {}),
    ...(r.detailsJson ? { details: JSON.parse(r.detailsJson) as Record<string, unknown> } : {}),
  };
}
