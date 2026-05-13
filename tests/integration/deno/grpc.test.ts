/**
 * gRPC-HTTP — in-Deno integration: real `grpcHttpApi` + real
 * `GrpcHttpClient` against the stub rig. Drives the shared
 * `moveSuite` twice so JSON and binary share assertions but
 * exercise different codec branches.
 */

/// <reference lib="deno.ns" />

import { runMoveSuite } from "../../suites/move-suite.ts";
import { startGrpcServer } from "../../factories/grpc.ts";
import { stubRig } from "../../rig.ts";
import { GrpcHttpClient } from "../../../src/grpc/http/client.ts";

const server = await startGrpcServer(stubRig());

runMoveSuite("GrpcHttpClient (deno, json)", {
  client: () => new GrpcHttpClient({ url: server.url, binary: false }),
});

runMoveSuite("GrpcHttpClient (deno, binary)", {
  client: () => new GrpcHttpClient({ url: server.url, binary: true }),
});

Deno.test({
  name: "GrpcHttpClient (deno) — cleanup",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => Promise.resolve(server.stop()),
});
