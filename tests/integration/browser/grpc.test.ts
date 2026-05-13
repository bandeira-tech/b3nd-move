/**
 * GrpcHttpClient Browser Integration Tests — JSON encoding.
 *
 * Run with:  deno task test:integration:grpc
 */

/// <reference lib="deno.ns" />

import { runBrowserSuite } from "../../browser/runner.ts";
import { startGrpcServer } from "../../factories/grpc.ts";
import { stubRig } from "../../rig.ts";

await runBrowserSuite({
  harnessEntry: new URL("../../browser/harnesses/grpc.ts", import.meta.url),
  startServer: () => startGrpcServer(stubRig(), { cors: true }),
});
