/**
 * HttpClient browser conformance driver.
 *
 * Thin shim: boots the real HTTP server (via the co-located plug, CORS on
 * for the cross-origin browser client) and points the shared browser
 * runner at the co-located harness. Each browser-side test (from
 * `move-suite.ts`) is re-registered as its own `Deno.test`.
 *
 * Run with:  deno task test:integration:http
 */

/// <reference lib="deno.ns" />

import { runBrowserSuite } from "../../browser/runner.ts";
import { httpPlug } from "../../../src/http/_conformance/plug.ts";
import { stubRig } from "../../rigs/stub.ts";

await runBrowserSuite({
  harnessEntry: new URL(
    "../../../src/http/_browser/harness.ts",
    import.meta.url,
  ),
  startServer: () => httpPlug.startServer(stubRig(), { cors: true }),
});
