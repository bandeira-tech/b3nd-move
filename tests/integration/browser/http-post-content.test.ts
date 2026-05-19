/**
 * httpPostContentApi Browser Integration Tests.
 *
 * Drives the shared browser runner against the POST-content facet booted
 * by `tests/factories/http-post-content.ts`. Each browser-side test
 * (registered in `harnesses/http-post-content.ts`) is re-registered as
 * its own `Deno.test`.
 *
 * Run with:  deno task test:integration:http-post-content
 */

/// <reference lib="deno.ns" />

import { runBrowserSuite } from "../../browser/runner.ts";
import { startHttpPostContentServer } from "../../factories/http-post-content.ts";

await runBrowserSuite({
  harnessEntry: new URL(
    "../../browser/harnesses/http-post-content.ts",
    import.meta.url,
  ),
  startServer: () => startHttpPostContentServer(),
});
