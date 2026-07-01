/**
 * httpPostContentApi Browser Integration Tests.
 *
 * Thin shim: boots the POST-content facet (via the co-located server) and
 * points the shared browser runner at the co-located harness.
 *
 * Run with:  deno task test:integration:http-post-content
 */

/// <reference lib="deno.ns" />

import { runBrowserSuite } from "../../browser/runner.ts";
import { startHttpPostContentServer } from "../../../src/http-post-content/_conformance/server.ts";

await runBrowserSuite({
  harnessEntry: new URL(
    "../../../src/http-post-content/_browser/harness.ts",
    import.meta.url,
  ),
  startServer: () => startHttpPostContentServer(),
});
