/**
 * @module
 * gRPC-HTTP API for the Rig.
 *
 * Standalone function that translates `B3ndService` RPCs to pin method
 * calls. No framework dependency, no middleware — just a
 * `(Request) => Promise<Response>`.
 *
 * Routes:
 *   POST /b3nd.v1.B3ndService/Receive  → ./receive.ts  (pin.receive(messages))
 *   POST /b3nd.v1.B3ndService/Read     → ./read.ts     (pin.read(urls))
 *   POST /b3nd.v1.B3ndService/Observe  → ./observe.ts  (pin.observe(urls), NDJSON)
 *   POST /b3nd.v1.B3ndService/Status   → ./status.ts   (pin.status())
 *
 * Encoding is negotiated by Content-Type:
 *   application/json, application/connect+json    → JSON  (default)
 *   application/proto, application/connect+proto,
 *   application/grpc, application/grpc-web+proto  → binary protobuf
 *
 * @bufbuild/protobuf handles bytes ↔ base64 automatically in JSON mode —
 * no manual base64 is needed anywhere in the routes.
 *
 * Observe always streams NDJSON regardless of encoding; the connectrpc
 * streaming envelope format is not implemented here.
 *
 * Unary methods (Receive, Read, Status) are compatible with
 * @connectrpc/connect-web out of the box — use
 *   createClient(B3ndService, createConnectTransport({ baseUrl }))
 *
 * This file's only job is to assemble the table and hand it to the
 * shared dispatcher.
 */

import type { ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core/types";
import { dispatchGrpc } from "./router.ts";
import { observeRoute } from "./observe.ts";
import { readRoute } from "./read.ts";
import { receiveRoute } from "./receive.ts";
import { statusRoute } from "./status.ts";
import type { GrpcBatchCodec } from "./codec.ts";

/** Options for `grpcHttpApi`. */
export interface GrpcHttpApiOptions {
  /** Codec for read/receive proto message construction. Required. */
  codec: GrpcBatchCodec;
}

/**
 * Create a gRPC-HTTP request handler.
 *
 * Returns a standard `(Request) => Promise<Response>` — plug into
 * `Deno.serve` or any fetch-compatible HTTP runtime. CORS is upstream
 * of the API: for cross-origin browser callers, compose `withCors`
 * (`@bandeira-tech/b3nd-move/cors`) around the handler —
 * `withCors(grpcHttpApi(pin, { codec }), { origin: "*" })`.
 */
export function grpcHttpApi(
  pin: ProtocolInterfaceNode,
  options: GrpcHttpApiOptions,
): (req: Request) => Promise<Response> {
  const { codec } = options;
  const routes = [
    statusRoute,
    receiveRoute(codec),
    readRoute(codec),
    observeRoute,
  ];
  return (req) => dispatchGrpc(pin, routes, req);
}
