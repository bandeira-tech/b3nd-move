/**
 * gRPC-HTTP transport factory for browser integration tests.
 *
 * Boots the *real* `grpcHttpApi(rig)` + `withCors` on an ephemeral
 * port, backed by the stub rig. The same handler serves both JSON
 * and binary clients — the move-suite browser harness pins the
 * client to JSON; the binary harness flips one constructor flag.
 */

/// <reference lib="deno.ns" />

import { grpcHttpApi } from "../../../src/grpc/http/service.ts";
import { withCors } from "../../../src/cors.ts";
import type { StubServerHandle } from "../browser-runner.ts";
import { stubRig } from "../stub-rig.ts";

export function startGrpcServer(): Promise<StubServerHandle> {
  const rig = stubRig();
  const handler = withCors(grpcHttpApi(rig), { origin: "*" });
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
