/**
 * WebSocketClient Browser Integration Tests.
 *
 * Drives the shared browser runner with the WS transport stub.
 * Each browser-side test (from `tests/runners/move-suite.ts`) is
 * re-registered as its own `Deno.test`.
 *
 * Run with:  deno task test:integration:ws
 */

/// <reference lib="deno.ns" />

import { runBrowserSuite } from "../../tests/runners/browser-runner.ts";
import { startWsStub } from "../../tests/runners/stubs/ws-stub.ts";

await runBrowserSuite({
  harnessEntry: new URL("./_browser/harness.ts", import.meta.url),
  startServer: () => startWsStub(),
});
