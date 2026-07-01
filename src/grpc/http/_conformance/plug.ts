/**
 * gRPC-over-HTTP transport plugs.
 *
 * The same server-side handler serves both encodings — binary is a
 * client-side choice — so the two plugs share one `startServer` and
 * differ only in the client's `binary` flag. Per the conformance-kit
 * convention, each plug still boots its own loopback server (one
 * plug = one server + one client config = one run); a second loopback
 * server in a test is negligible and keeps every run uniform.
 *
 * Publish-excluded test support (see `deno.json`).
 */

/// <reference lib="deno.ns" />

import type { ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core/types";
import type {
  MovePlug,
  ServerHandle,
  StartOpts,
} from "../../../../tests/suites/move-plug.ts";
import { grpcHttpApi } from "../service.ts";
import { GrpcHttpClient } from "../client.ts";
import { withCors } from "../../../cors.ts";
import { grpcProto } from "../../../codecs/grpc/mod.ts";

const codec = grpcProto();

function startGrpcServer(
  rig: ProtocolInterfaceNode,
  opts?: StartOpts,
): ServerHandle {
  const api = grpcHttpApi(rig, { codec });
  const handler = opts?.cors ? withCors(api, { origin: "*" }) : api;
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    handler,
  );
  const { port } = server.addr as Deno.NetAddr;
  return { url: `http://127.0.0.1:${port}`, stop: () => server.shutdown() };
}

export const grpcJsonPlug: MovePlug = {
  name: "grpc-json",
  startServer: startGrpcServer,
  makeClient: (url) => new GrpcHttpClient({ url, codec, binary: false }),
};

export const grpcBinaryPlug: MovePlug = {
  name: "grpc-binary",
  startServer: startGrpcServer,
  makeClient: (url) => new GrpcHttpClient({ url, codec, binary: true }),
};
