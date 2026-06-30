/**
 * Browser entry for the HttpClient integration test.
 *
 * Bundled by `tests/integration/browser/http.test.ts`. The first
 * import installs `globalThis.Deno.test` collection (a side effect),
 * which must happen before importing the move suite.
 */

import { serverUrl, setupHarness } from "../deno-stub.ts";
import { HttpClient } from "../../../src/http/client.ts";
import { runMoveSuite } from "../../suites/move-suite.ts";
import { httpOutputsFrame } from "../../../src/codecs/http/mod.ts";

const codec = httpOutputsFrame();
const enc = new TextEncoder();
runMoveSuite("HttpClient (browser)", {
  client: () => new HttpClient({ url: serverUrl(), codec }),
  // HTTP wire is opaque bytes past the URL — encode JS payloads once
  // before they cross the wire.
  payload: (v) => enc.encode(JSON.stringify(v)),
});

setupHarness();
