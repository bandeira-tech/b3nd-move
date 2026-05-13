/**
 * Browser entry for the HttpClient integration test.
 *
 * Bundled by `src/http/integration.test.ts` via the generic
 * `tests/runners/browser-runner.ts`. The deno-loader esbuild plugin
 * resolves `@bandeira-tech/b3nd-move/http/client` from this repo's
 * own deno.json — i.e. we're testing THIS source, not the published
 * package.
 *
 * The first import installs `globalThis.Deno.test` collection (a
 * side effect), which must happen before importing the move suite.
 */

import {
  serverUrl,
  setupHarness,
} from "../../../tests/helpers/browser-deno-stub.ts";
import { HttpClient } from "../client.ts";
import { runMoveSuite } from "../../../tests/runners/move-suite.ts";

runMoveSuite("HttpClient (browser)", {
  client: () => new HttpClient({ url: serverUrl() }),
});

setupHarness();
