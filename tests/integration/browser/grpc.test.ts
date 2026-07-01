/**
 * GrpcHttpClient browser conformance driver — JSON encoding.
 *
 * Thin shim: boots the real gRPC-HTTP server (via the co-located JSON
 * plug, CORS on) and points the shared browser runner at the co-located
 * JSON harness.
 *
 * Run with:  deno task test:integration:grpc
 */

/// <reference lib="deno.ns" />

import { runBrowserSuite } from "../../browser/runner.ts";
import { grpcJsonPlug } from "../../../src/grpc/http/_conformance/plug.ts";
import { stubRig } from "../../rigs/stub.ts";

await runBrowserSuite({
  harnessEntry: new URL(
    "../../../src/grpc/http/_browser/harness-json.ts",
    import.meta.url,
  ),
  startServer: () => grpcJsonPlug.startServer(stubRig(), { cors: true }),
});
