/**
 * Browser entry for the WebSocketClient conformance run.
 *
 * `reconnect: { enabled: false }` keeps the client from swallowing a
 * closed socket — we want the suite to surface transport behavior, not
 * background recovery. Self-contained (client + codec only); see the
 * http harness for why the plug isn't imported here.
 */

import { serverUrl, setupHarness } from "../../../tests/browser/deno-stub.ts";
import { WebSocketClient } from "../client.ts";
import { runMoveSuite } from "../../../tests/suites/move-suite.ts";
import { wsJsonEnvelope } from "../../codecs/ws/mod.ts";

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
