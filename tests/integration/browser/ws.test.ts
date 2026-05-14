/**
 * WebSocketClient Browser Integration Tests.
 *
 * Run with:  deno task test:integration:ws
 */

/// <reference lib="deno.ns" />

import { runBrowserSuite } from "../../browser/runner.ts";
import { startWsServer } from "../../factories/ws.ts";
import { stubRig } from "../../rigs/stub.ts";

await runBrowserSuite({
  harnessEntry: new URL("../../browser/harnesses/ws.ts", import.meta.url),
  startServer: () => startWsServer(stubRig()),
});
