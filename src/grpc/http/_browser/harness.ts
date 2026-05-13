/**
 * Browser entry for the GrpcHttpClient integration test.
 *
 * Bundled by `src/grpc/http/integration.test.ts`. The first import
 * installs `globalThis.Deno.test` collection (a side effect), which
 * must happen before importing the move suite.
 *
 * Uses the default JSON encoding (`binary: false`) — the stub mirrors
 * that wire format. Binary protobuf takes the same encode/decode path
 * once the Content-Type branch is selected; covering JSON is enough
 * to prove the move layer here.
 */

import {
  serverUrl,
  setupHarness,
} from "../../../../tests/helpers/browser-deno-stub.ts";
import { GrpcHttpClient } from "../client.ts";
import { runMoveSuite } from "../../../../tests/runners/move-suite.ts";

runMoveSuite("GrpcHttpClient (browser, json)", {
  client: () => new GrpcHttpClient({ url: serverUrl() }),
});

setupHarness();
