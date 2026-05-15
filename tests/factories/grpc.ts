/**
 * gRPC-HTTP transport factory for integration tests.
 *
 * Boots `grpcHttpApi(rig)` on an ephemeral loopback port. The same
 * handler serves both JSON and binary clients — the encoding is a
 * client-side choice.
 */

/// <reference lib="deno.ns" />

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import { grpcHttpApi } from "../../src/grpc/http/service.ts";
import { withCors } from "./cors.ts";
import type { HttpServerOptions, ServerHandle } from "./http.ts";

export function startGrpcServer(
  rig: Rig,
  opts: HttpServerOptions = {},
): Promise<ServerHandle> {
  const handler = opts.cors
    ? withCors(grpcHttpApi(rig), "*")
    : grpcHttpApi(rig);
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
