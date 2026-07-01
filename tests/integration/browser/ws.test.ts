/**
 * WebSocketClient browser conformance driver.
 *
 * Thin shim: boots the real WS server (via the co-located plug) and
 * points the shared browser runner at the co-located harness.
 *
 * Run with:  deno task test:integration:ws
 */

/// <reference lib="deno.ns" />

import { runBrowserSuite } from "../../browser/runner.ts";
import { wsPlug } from "../../../src/ws/_conformance/plug.ts";
import { stubRig } from "../../rigs/stub.ts";

await runBrowserSuite({
  harnessEntry: new URL("../../../src/ws/_browser/harness.ts", import.meta.url),
  startServer: () => wsPlug.startServer(stubRig()),
});
