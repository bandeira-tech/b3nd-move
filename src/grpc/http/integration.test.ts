/**
 * GrpcHttpClient Browser Integration Tests.
 *
 * Drives the shared browser runner with the gRPC-HTTP transport stub.
 * Each browser-side test (from `tests/runners/move-suite.ts`) is
 * re-registered as its own `Deno.test`.
 *
 * Run with:  deno task test:integration:grpc
 */

/// <reference lib="deno.ns" />

import { runBrowserSuite } from "../../../tests/runners/browser-runner.ts";
import { startGrpcServer } from "../../../tests/runners/servers/grpc-server.ts";

await runBrowserSuite({
  harnessEntry: new URL("./_browser/harness.ts", import.meta.url),
  startServer: () => startGrpcServer(),
});
