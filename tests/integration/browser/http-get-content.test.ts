/**
 * httpGetContentApi Browser Integration Tests.
 *
 * Thin shim: boots the GET-content facet (via the co-located server) and
 * points the shared browser runner at the co-located harness.
 *
 * Run with:  deno task test:integration:http-get-content
 */

/// <reference lib="deno.ns" />

import { runBrowserSuite } from "../../browser/runner.ts";
import { startHttpGetContentServer } from "../../../src/http-get-content/_conformance/server.ts";

await runBrowserSuite({
  harnessEntry: new URL(
    "../../../src/http-get-content/_browser/harness.ts",
    import.meta.url,
  ),
  startServer: () => startHttpGetContentServer(),
});
