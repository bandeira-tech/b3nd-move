/**
 * GrpcHttpClient browser conformance driver — binary encoding.
 *
 * Same shape as `grpc.test.ts` but pinned to `application/proto`.
 *
 * Run with:  deno task test:integration:grpc-binary
 */

/// <reference lib="deno.ns" />

import { runBrowserSuite } from "../../browser/runner.ts";
import { grpcBinaryPlug } from "../../../src/grpc/http/_conformance/plug.ts";
import { stubRig } from "../../rigs/stub.ts";

await runBrowserSuite({
  harnessEntry: new URL(
    "../../../src/grpc/http/_browser/harness-binary.ts",
    import.meta.url,
  ),
  startServer: () => grpcBinaryPlug.startServer(stubRig(), { cors: true }),
});
