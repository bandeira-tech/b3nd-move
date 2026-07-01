/**
 * Browser entry for the HttpClient conformance run.
 *
 * Bundled by `tests/integration/browser/http.test.ts` and run inside
 * headless Chromium. The first import installs `globalThis.Deno.test`
 * collection (a side effect), which must happen before importing the
 * move suite.
 *
 * Self-contained (client + codec only) rather than importing the plug —
 * the server-side plug pulls in `Deno.serve` boot code that has no place
 * in the browser bundle. The one-line client build is cheap to restate.
 */

import { serverUrl, setupHarness } from "../../../tests/browser/deno-stub.ts";
import { HttpClient } from "../client.ts";
import { runMoveSuite } from "../../../tests/suites/move-suite.ts";
import { httpOutputsFrame } from "../../codecs/http/mod.ts";

const codec = httpOutputsFrame();
const enc = new TextEncoder();

runMoveSuite("HttpClient (browser)", {
  client: () => new HttpClient({ url: serverUrl(), codec }),
  payload: (v) => enc.encode(JSON.stringify(v)),
});

setupHarness();
