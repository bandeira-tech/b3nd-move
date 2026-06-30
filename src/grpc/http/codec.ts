/**
 * @module
 * Batch codec contract for gRPC-HTTP read + receive request/response messages.
 *
 * gRPC's wire is proto messages, not free-form. The codec wraps the
 * `outputToProto` / `outputFromProto` / `receiveResultToProto` /
 * `receiveResultFromProto` converters (today's behavior) and provides the
 * seam operators declare at construction time.
 *
 * ## Route ↔ codec split
 *
 * The codec owns proto message construction and stream materialization. The
 * route owns HTTP framing (wrapping in `okResponse`, parsing `encoding`).
 *
 *   read:    server decodes `ReadRequest` → string[]
 *            server encodes `Output[]`    → `ReadResponse`
 *   receive: server decodes `ReceiveRequest` → Output[]
 *            server encodes `ReceiveResult[]` → `ReceiveResponse`
 *
 * Client-side inverses mirror the server methods.
 *
 * ## Context
 *
 * `GrpcEncodeCtx.signal` is derived from the dispatcher's per-request
 * `AbortController.signal` (see `GrpcContext.abort` in router.ts). The route
 * layer passes `ctx.abort.signal` when calling `encodeRead`; the codec threads
 * it into `materializeStreams` so an aborted request cancels stream pumping at
 * chunk boundaries.
 */

import type { Output, ReceiveResult } from "@bandeira-tech/b3nd-core/types";
import type {
  ReadRequest,
  ReadResponse,
  ReceiveRequest,
  ReceiveResponse,
} from "../proto/gen/b3nd_pb.ts";

/** Encode-time context handed to `encodeRead` and `encodeReceive`. */
export interface GrpcEncodeCtx {
  /**
   * Per-request abort signal. Derived from `GrpcContext.abort.signal` by the
   * route layer. Wired into `materializeStreams` so an aborted request cancels
   * stream pumping at chunk boundaries.
   */
  signal: AbortSignal;
}

/**
 * Batch codec contract for gRPC-HTTP read + receive.
 *
 * Eight methods — four server-side (one encode + one decode per RPC), four
 * client-side (inverse pair per RPC). The codec owns proto type construction;
 * the route owns HTTP framing.
 *
 * Implement this interface to swap the gRPC wire representation without
 * touching any route or dispatcher code. In v1 exactly one implementation
 * ships: `grpcProto` (see `src/codecs/grpc/proto.ts`).
 */
export interface GrpcBatchCodec {
  // ── Server-side: Read RPC ─────────────────────────────────────────────

  /**
   * Server: encode `Output[]` (from `rig.read`) into a `ReadResponse` proto
   * message. Implementations must materialize any `ReadableStream<Uint8Array>`
   * payloads to concrete `Uint8Array` before calling `outputToProto`, because
   * `JSON.stringify(stream) === "{}"` (the M3 stealth bug in PR #50).
   *
   * The route wraps the returned message in `okResponse(ReadResponseSchema, …)`
   * for wire encoding.
   */
  encodeRead(
    outputs: Output[],
    ctx: GrpcEncodeCtx,
  ): ReadResponse | Promise<ReadResponse>;

  /**
   * Server: decode a parsed `ReadRequest` proto message into the URL strings
   * passed to `rig.read`.
   */
  decodeRead(req: ReadRequest): string[];

  // ── Server-side: Receive RPC ──────────────────────────────────────────

  /**
   * Server: encode `ReceiveResult[]` (from `rig.receive`) into a
   * `ReceiveResponse` proto message.
   *
   * The route wraps the returned message in `okResponse(ReceiveResponseSchema, …)`.
   */
  encodeReceive(
    results: ReceiveResult[],
    ctx: GrpcEncodeCtx,
  ): ReceiveResponse | Promise<ReceiveResponse>;

  /**
   * Server: decode a parsed `ReceiveRequest` proto message into the `Output[]`
   * passed to `rig.receive`.
   */
  decodeReceive(req: ReceiveRequest): Output[];

  // ── Client-side: Read RPC ─────────────────────────────────────────────

  /**
   * Client: decode a `ReadResponse` proto message back into `Output[]`.
   * Inverse of `encodeRead`.
   */
  decodeReadResponse(res: ReadResponse): Output[];

  /**
   * Client: encode `string[]` URLs into a `ReadRequest` proto message to send
   * to the server.
   */
  encodeReadRequest(urls: string[]): ReadRequest;

  // ── Client-side: Receive RPC ──────────────────────────────────────────

  /**
   * Client: decode a `ReceiveResponse` proto message back into
   * `ReceiveResult[]`. Inverse of `encodeReceive`.
   */
  decodeReceiveResponse(res: ReceiveResponse): ReceiveResult[];

  /**
   * Client: encode `Output[]` into a `ReceiveRequest` proto message to send
   * to the server.
   */
  encodeReceiveRequest(outputs: Output[]): ReceiveRequest;
}
