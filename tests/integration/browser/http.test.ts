/**
 * HttpClient Browser Integration Tests.
 *
 * Drives the shared browser runner with the HTTP factory, backed by
 * the stub rig. Each browser-side test (from `suites/move-suite.ts`)
 * is re-registered as its own `Deno.test`.
 *
 * Run with:  deno task test:integration:http
 */

/// <reference lib="deno.ns" />

import { runBrowserSuite } from "../../browser/runner.ts";
import { startHttpServer } from "../../factories/http.ts";
import { stubRig } from "../../rigs/stub.ts";
import { httpOutputsFrame } from "../../../src/codecs/http/mod.ts";

const codec = httpOutputsFrame();

await runBrowserSuite({
  harnessEntry: new URL("../../browser/harnesses/http.ts", import.meta.url),
  startServer: () => startHttpServer(stubRig(), { cors: true, codec }),
});
