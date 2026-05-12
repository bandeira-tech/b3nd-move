/**
 * @module
 * gRPC-HTTP subpath — server resolver, handler, client, and proto.
 *
 * For finer-grained imports:
 *   @bandeira-tech/b3nd-servers/grpc/http/api    — handler only (any runtime)
 *   @bandeira-tech/b3nd-servers/grpc/http/server — Deno.serve resolver (Deno only)
 *   @bandeira-tech/b3nd-servers/grpc/http/client — GrpcHttpClient (universal)
 *   @bandeira-tech/b3nd-servers/grpc/proto       — wire schema + converters
 */

// ── Server ──────────────────────────────────────────────────────────────────
export { grpcHttpApi, grpcHttpServer } from "./libs/b3nd-server-grpchttp/mod.ts";
export type { GrpcHttpServerOptions } from "./libs/b3nd-server-grpchttp/mod.ts";

// ── Client ──────────────────────────────────────────────────────────────────
export { GrpcHttpClient } from "./libs/b3nd-client-grpchttp/mod.ts";
export type { GrpcHttpClientConfig } from "./libs/b3nd-client-grpchttp/mod.ts";

// ── Proto ────────────────────────────────────────────────────────────────────
export type {
  ObserveRequest,
  OutputProto,
  ReadRequest,
  ReadResponse,
  ReceiveRequest,
  ReceiveResponse,
  ReceiveResultProto,
  StatusRequest,
  StatusResponse,
} from "./libs/b3nd-proto/mod.ts";
export {
  B3ndService,
  outputFromProto,
  outputToProto,
  receiveResultFromProto,
  receiveResultToProto,
  statusResponseToResult,
  statusResultToResponse,
} from "./libs/b3nd-proto/mod.ts";
