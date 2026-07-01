/**
 * Browser entry for the GrpcHttpClient conformance run — BINARY encoding
 * (`application/proto`). The same server-side handler serves both
 * encodings; flipping `binary: true` exercises the protobuf wire-format
 * codec branch end-to-end across the browser boundary. Self-contained.
 */

import {
  serverUrl,
  setupHarness,
} from "../../../../tests/browser/deno-stub.ts";
import { GrpcHttpClient } from "../client.ts";
import { grpcProto } from "../../../codecs/grpc/mod.ts";
import { runMoveSuite } from "../../../../tests/suites/move-suite.ts";

const codec = grpcProto();

runMoveSuite("GrpcHttpClient (browser, binary)", {
  client: () => new GrpcHttpClient({ url: serverUrl(), codec, binary: true }),
});

setupHarness();
