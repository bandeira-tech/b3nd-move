/**
 * Browser entry for the WebSocketClient integration test.
 *
 * Bundled by `src/ws/integration.test.ts` via the shared browser
 * runner. The first import installs `globalThis.Deno.test` collection
 * (a side effect), which must happen before importing the move suite.
 *
 * `reconnect: { enabled: false }` keeps the client from swallowing
 * a closed socket — we want the suite to surface transport behavior,
 * not background recovery.
 */

import {
  serverUrl,
  setupHarness,
} from "../../../tests/helpers/browser-deno-stub.ts";
import { WebSocketClient } from "../client.ts";
import { runMoveSuite } from "../../../tests/runners/move-suite.ts";

runMoveSuite("WebSocketClient (browser)", {
  client: () =>
    new WebSocketClient({
      url: serverUrl(),
      reconnect: { enabled: false },
    }),
});

setupHarness();
