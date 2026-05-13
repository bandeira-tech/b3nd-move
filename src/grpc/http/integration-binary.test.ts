/**
 * GrpcHttpClient Browser Integration Tests — binary encoding.
 *
 * Same shape as `integration.test.ts` but pinned to
 * `application/proto`. Exercises the protobuf wire-format encode/
 * decode path of the move layer end-to-end in a real browser.
 *
 * Run with:  deno task test:integration:grpc-binary
 */

/// <reference lib="deno.ns" />

import { runBrowserSuite } from "../../../tests/runners/browser-runner.ts";
import { startGrpcServer } from "../../../tests/runners/servers/grpc-server.ts";

await runBrowserSuite({
  harnessEntry: new URL("./_browser/harness-binary.ts", import.meta.url),
  startServer: () => startGrpcServer(),
});
