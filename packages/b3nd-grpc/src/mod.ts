/**
 * @module
 * B3nd gRPC — Connect-protocol client + server bundle.
 *
 * Re-exports the gRPC client (ProtocolInterfaceNode), server resolver,
 * and the wire schema/converters used by both ends.
 */

// ── Client ──
export { GrpcClient } from "../libs/b3nd-client-grpc/mod.ts";
export type { GrpcClientConfig } from "../libs/b3nd-client-grpc/mod.ts";

// ── Server ──
export { createGrpcHandler, grpcServer } from "../libs/b3nd-server-grpc/mod.ts";
export type { GrpcServerOptions } from "../libs/b3nd-server-grpc/mod.ts";

// ── Proto wire types & converters ──
export type {
  ObserveRequest,
  ReadRequest,
  ReadResponse,
  ReadResultProto,
  ReceiveRequest,
  ReceiveResponse,
  RecordProto,
  StatusRequest,
  StatusResponse,
} from "../libs/b3nd-proto/schema.ts";
export {
  messageToReceiveRequest,
  readResultFromProto,
  readResultToProto,
  receiveRequestToMessage,
  receiveResponseToResult,
  receiveResultToResponse,
  statusResponseToResult,
  statusResultToResponse,
} from "../libs/b3nd-proto/convert.ts";
