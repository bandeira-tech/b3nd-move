/**
 * @module
 * gRPC batch codecs catalog. Operators import from here:
 *
 * ```ts
 * import { grpcProto } from "@bandeira-tech/b3nd-move/codecs/grpc";
 * grpcHttpApi(rig, { codec: grpcProto() });
 * ```
 *
 * Only one codec ships for gRPC in v1: `grpcProto`, which packages today's
 * baked behavior (proto message construction via `outputToProto` et al.) and
 * resolves the M3 stream-materialization bug from PR #50.
 */

export { grpcProto } from "./proto.ts";
export type { GrpcProtoOptions } from "./proto.ts";
