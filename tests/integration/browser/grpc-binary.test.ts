/**
 * GrpcHttpClient Browser Integration Tests — binary encoding.
 *
 * Same shape as `grpc.test.ts` but pinned to `application/proto`.
 *
 * Run with:  deno task test:integration:grpc-binary
 */

/// <reference lib="deno.ns" />

import { runBrowserSuite } from "../../browser/runner.ts";
import { startGrpcServer } from "../../factories/grpc.ts";
import { stubRig } from "../../rigs/stub.ts";
import { grpcProto } from "../../../src/codecs/grpc/mod.ts";

await runBrowserSuite({
  harnessEntry: new URL(
    "../../browser/harnesses/grpc-binary.ts",
    import.meta.url,
  ),
  startServer: () =>
    startGrpcServer(stubRig(), { cors: true, codec: grpcProto() }),
});
