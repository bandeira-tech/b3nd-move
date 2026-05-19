/**
 * httpGetContentApi Browser Integration Tests.
 *
 * Drives the shared browser runner against the GET-content facet booted
 * by `tests/factories/http-get-content.ts`. Each browser-side test
 * (registered in `harnesses/http-get-content.ts`) is re-registered as
 * its own `Deno.test`.
 *
 * Run with:  deno task test:integration:http-get-content
 */

/// <reference lib="deno.ns" />

import { runBrowserSuite } from "../../browser/runner.ts";
import { startHttpGetContentServer } from "../../factories/http-get-content.ts";

await runBrowserSuite({
  harnessEntry: new URL(
    "../../browser/harnesses/http-get-content.ts",
    import.meta.url,
  ),
  startServer: () => startHttpGetContentServer(),
});
