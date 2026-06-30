/**
 * WebSocketClient Browser Integration Tests.
 *
 * Run with:  deno task test:integration:ws
 */

/// <reference lib="deno.ns" />

import { runBrowserSuite } from "../../browser/runner.ts";
import { startWsServer } from "../../factories/ws.ts";
import { stubRig } from "../../rigs/stub.ts";
import { wsJsonEnvelope } from "../../../src/codecs/ws/mod.ts";

const codec = wsJsonEnvelope();

await runBrowserSuite({
  harnessEntry: new URL("../../browser/harnesses/ws.ts", import.meta.url),
  startServer: () => startWsServer(stubRig(), { codec }),
});
