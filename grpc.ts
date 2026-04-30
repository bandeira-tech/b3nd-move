/**
 * @module
 * gRPC subpath — server resolver, pure handler, client, and wire schema.
 *
 * For finer-grained imports (smaller bundles), use:
 *   • `@bandeira-tech/b3nd-servers/grpc/server`  — server-only
 *   • `@bandeira-tech/b3nd-servers/grpc/client`  — client-only (browser-safe)
 *   • `@bandeira-tech/b3nd-servers/grpc/proto`   — wire schema + converters
 */

// ── Server ──
export { grpcApi, grpcServer } from "./libs/b3nd-server-grpc/mod.ts";
export type { GrpcServerOptions } from "./libs/b3nd-server-grpc/mod.ts";

// ── Client ──
export { GrpcClient } from "./libs/b3nd-client-grpc/mod.ts";
export type { GrpcClientConfig } from "./libs/b3nd-client-grpc/mod.ts";

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
} from "./libs/b3nd-proto/schema.ts";
export {
  messageToReceiveRequest,
  readResultFromProto,
  readResultToProto,
  receiveRequestToMessage,
  receiveResponseToResult,
  receiveResultToResponse,
  statusResponseToResult,
  statusResultToResponse,
} from "./libs/b3nd-proto/convert.ts";
