/**
 * Browser entry for the GrpcHttpClient integration test — BINARY
 * encoding (`application/proto`).
 *
 * Bundled by `src/grpc/http/integration-binary.test.ts`. The same
 * server-side handler serves both encodings; this harness flips the
 * client constructor to `binary: true` to exercise the codec branch
 * that handles protobuf wire format end-to-end across the browser
 * boundary.
 */

import {
  serverUrl,
  setupHarness,
} from "../../../../tests/helpers/browser-deno-stub.ts";
import { GrpcHttpClient } from "../client.ts";
import { runMoveSuite } from "../../../../tests/runners/move-suite.ts";

runMoveSuite("GrpcHttpClient (browser, binary)", {
  client: () => new GrpcHttpClient({ url: serverUrl(), binary: true }),
});

setupHarness();
