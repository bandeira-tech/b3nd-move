/**
 * @module
 * gRPC client subpath — the `GrpcClient` class.
 *
 * Speaks Connect protocol (JSON over HTTP/2) to a B3nd gRPC server.
 */

export { GrpcClient } from "./libs/b3nd-client-grpc/mod.ts";
export type { GrpcClientConfig } from "./libs/b3nd-client-grpc/mod.ts";
