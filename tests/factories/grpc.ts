/**
 * gRPC-HTTP transport factory for integration tests.
 *
 * Boots `grpcHttpApi(rig, { codec })` on an ephemeral loopback port. The same
 * handler serves both JSON and binary clients — the encoding is a
 * client-side choice.
 */

/// <reference lib="deno.ns" />

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import type { GrpcBatchCodec } from "../../src/grpc/http/codec.ts";
import { grpcHttpApi } from "../../src/grpc/http/service.ts";
import type { ServerHandle } from "./http.ts";

export interface GrpcServerOptions {
  /** Codec for read/receive proto message construction. Required. */
  codec: GrpcBatchCodec;
  /** Operator-declared CORS (permissive `*`). Default: false. */
  cors?: boolean;
}

export function startGrpcServer(
  rig: Rig,
  opts: GrpcServerOptions,
): Promise<ServerHandle> {
  const handler = grpcHttpApi(rig, { codec: opts.codec, cors: opts.cors });
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    handler,
  );
  const { port } = server.addr as Deno.NetAddr;
  return Promise.resolve({
    url: `http://127.0.0.1:${port}`,
    stop: () => server.shutdown(),
  });
}
