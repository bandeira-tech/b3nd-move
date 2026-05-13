/**
 * HttpClient Browser Integration Tests.
 *
 * Drives the shared browser runner with the HTTP transport stub.
 * Each browser-side test (from `tests/runners/move-suite.ts`) is
 * re-registered as its own `Deno.test`. Astral downloads its own
 * Chromium on first run and caches it; no external services
 * required.
 *
 * Run with:  deno task test:integration:http
 */

/// <reference lib="deno.ns" />

import { runBrowserSuite } from "../../tests/runners/browser-runner.ts";
import { startHttpServer } from "../../tests/runners/servers/http-server.ts";

await runBrowserSuite({
  harnessEntry: new URL("./_browser/harness.ts", import.meta.url),
  startServer: () => startHttpServer(),
});
