/**
 * @module
 * `grpcProto` — today's baked gRPC behavior, made explicit.
 *
 * Packages the default gRPC-HTTP read/receive codec as an operator-declared
 * value. Today the gRPC routes hardcode their encode/decode logic inline in
 * `src/grpc/http/read.ts` and `src/grpc/http/receive.ts`; this codec captures
 * that exact behavior so Task 12 can wire it in and make the seam
 * configurable without changing any observable wire behavior.
 *
 * ## M3 fix (PR #50 stealth bug)
 *
 * The baked routes call `outputToProto` directly on `rig.read` results.
 * `outputToProto` calls `JSON.stringify(payload)` for non-`Uint8Array`
 * payloads via `encodePayload`. A `ReadableStream` is not a `Uint8Array`,
 * so `JSON.stringify(stream) === "{}"` — bytes are silently lost.
 *
 * `grpcProto.encodeRead` calls `materializeStreams` BEFORE `outputToProto`
 * ever sees the outputs. After materialization every stream slot is a
 * concrete `Uint8Array`, so `outputToProto` takes the binary path and the
 * bug is structurally impossible.
 *
 * ## Scheduler
 *
 * Materialization runs through a `Scheduler` (default `Promise.all`). Hosts
 * that need fan-out caps inject one at construction:
 * `grpcProto({ scheduler: pLimitTo4 })`.
 */

import { create } from "@bufbuild/protobuf";
import type { Output, ReceiveResult } from "@bandeira-tech/b3nd-core/types";
import type { GrpcBatchCodec, GrpcEncodeCtx } from "../../grpc/http/codec.ts";
import {
  outputFromProto,
  outputToProto,
  receiveResultFromProto,
  receiveResultToProto,
} from "../../grpc/proto/convert.ts";
import {
  ReadRequestSchema,
  ReadResponseSchema,
  ReceiveRequestSchema,
  ReceiveResponseSchema,
} from "../../grpc/proto/gen/b3nd_pb.ts";
import type {
  ReadRequest,
  ReadResponse,
  ReceiveRequest,
  ReceiveResponse,
} from "../../grpc/proto/gen/b3nd_pb.ts";
import { materializeStreams } from "../materialize.ts";
import { defaultScheduler, type Scheduler } from "../scheduler.ts";

export interface GrpcProtoOptions {
  /** Fan-out scheduler for per-slot stream materialization. Defaults to `Promise.all`. */
  scheduler?: Scheduler;
}

/**
 * Returns a `GrpcBatchCodec` that replicates today's baked gRPC-HTTP behavior.
 *
 * @param opts.scheduler  Fan-out policy for stream materialization.
 *   Defaults to `Promise.all`. Inject a semaphore or token-bucket scheduler
 *   to cap concurrency without changing the codec contract.
 */
export function grpcProto(opts: GrpcProtoOptions = {}): GrpcBatchCodec {
  const scheduler = opts.scheduler ?? defaultScheduler;

  return {
    /**
     * Server: materialize any `ReadableStream<Uint8Array>` slot payloads to
     * concrete `Uint8Array` values BEFORE calling `outputToProto`. This is the
     * M3 fix: `outputToProto`'s `JSON.stringify` path never sees a stream.
     */
    async encodeRead(
      outputs: Output[],
      ctx: GrpcEncodeCtx,
    ): Promise<ReadResponse> {
      const concrete = await materializeStreams(outputs, scheduler, ctx.signal);
      return create(ReadResponseSchema, {
        results: concrete.map(outputToProto),
      });
    },

    /**
     * Server: extract URL strings from a parsed `ReadRequest`.
     */
    decodeRead(req: ReadRequest): string[] {
      return req.urls ?? [];
    },

    /**
     * Server: encode `ReceiveResult[]` into a `ReceiveResponse` proto message.
     * `ReceiveResult` carries no stream payloads, so no materialization is needed.
     */
    encodeReceive(
      results: ReceiveResult[],
      _ctx: GrpcEncodeCtx,
    ): ReceiveResponse {
      return create(ReceiveResponseSchema, {
        results: results.map(receiveResultToProto),
      });
    },

    /**
     * Server: decode a `ReceiveRequest` proto message into `Output[]` for
     * `rig.receive`.
     */
    decodeReceive(req: ReceiveRequest): Output[] {
      return (req.messages ?? []).map(outputFromProto);
    },

    /**
     * Client: decode a `ReadResponse` proto message back into `Output[]`.
     * Inverse of `encodeRead` (modulo materialization, which is one-way).
     */
    decodeReadResponse(res: ReadResponse): Output[] {
      return (res.results ?? []).map(outputFromProto);
    },

    /**
     * Client: decode a `ReceiveResponse` proto message back into
     * `ReceiveResult[]`. Inverse of `encodeReceive`.
     */
    decodeReceiveResponse(res: ReceiveResponse): ReceiveResult[] {
      return (res.results ?? []).map(receiveResultFromProto);
    },

    /**
     * Client: encode URL strings into a `ReadRequest` proto message.
     */
    encodeReadRequest(urls: string[]): ReadRequest {
      return create(ReadRequestSchema, { urls });
    },

    /**
     * Client: encode `Output[]` into a `ReceiveRequest` proto message.
     */
    encodeReceiveRequest(outputs: Output[]): ReceiveRequest {
      return create(ReceiveRequestSchema, {
        messages: outputs.map(outputToProto),
      });
    },
  };
}
