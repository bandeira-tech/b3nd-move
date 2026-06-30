/**
 * gRPC-HTTP — in-Deno integration: real `grpcHttpApi` + real
 * `GrpcHttpClient` against `stubRig` (canned responses). Drives
 * `runMoveSuite` twice — once with JSON codec, once with binary —
 * so both encode/decode branches are exercised over the wire.
 */

/// <reference lib="deno.ns" />

import { runMoveSuite } from "../../suites/move-suite.ts";
import { startGrpcServer } from "../../factories/grpc.ts";
import { stubRig } from "../../rigs/stub.ts";
import { GrpcHttpClient } from "../../../src/grpc/http/client.ts";
import { grpcProto } from "../../../src/codecs/grpc/mod.ts";

const codec = grpcProto();
const server = await startGrpcServer(stubRig(), { codec });

runMoveSuite("grpc-json", {
  client: () => new GrpcHttpClient({ url: server.url, codec, binary: false }),
});

runMoveSuite("grpc-binary", {
  client: () => new GrpcHttpClient({ url: server.url, codec, binary: true }),
});

Deno.test({
  name: "[grpc] teardown",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => server.stop(),
});
