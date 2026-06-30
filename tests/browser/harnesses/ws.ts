/**
 * Browser entry for the WebSocketClient integration test.
 *
 * `reconnect: { enabled: false }` keeps the client from swallowing
 * a closed socket — we want the suite to surface transport behavior,
 * not background recovery.
 */

import { serverUrl, setupHarness } from "../deno-stub.ts";
import { WebSocketClient } from "../../../src/ws/client.ts";
import { runMoveSuite } from "../../suites/move-suite.ts";
import { wsJsonEnvelope } from "../../../src/codecs/ws/mod.ts";

const codec = wsJsonEnvelope();

runMoveSuite("WebSocketClient (browser)", {
  client: () =>
    new WebSocketClient({
      url: serverUrl(),
      codec,
      reconnect: { enabled: false },
    }),
});

setupHarness();
