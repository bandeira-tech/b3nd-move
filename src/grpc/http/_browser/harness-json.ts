/**
 * Browser entry for the GrpcHttpClient conformance run — JSON encoding
 * (default). Self-contained; see the http harness for why the plug isn't
 * imported here.
 */

import {
  serverUrl,
  setupHarness,
} from "../../../../tests/browser/deno-stub.ts";
import { GrpcHttpClient } from "../client.ts";
import { grpcProto } from "../../../codecs/grpc/mod.ts";
import { runMoveSuite } from "../../../../tests/suites/move-suite.ts";

const codec = grpcProto();

runMoveSuite("GrpcHttpClient (browser, json)", {
  client: () => new GrpcHttpClient({ url: serverUrl(), codec }),
});

setupHarness();
