/**
 * Browser entry for the GrpcHttpClient integration test — BINARY
 * encoding (`application/proto`).
 *
 * The same server-side handler serves both encodings; flipping
 * `binary: true` exercises the codec branch that handles protobuf
 * wire format end-to-end across the browser boundary.
 */

import { serverUrl, setupHarness } from "../deno-stub.ts";
import { GrpcHttpClient } from "../../../src/grpc/http/client.ts";
import { grpcProto } from "../../../src/codecs/grpc/mod.ts";
import { runMoveSuite } from "../../suites/move-suite.ts";

const codec = grpcProto();

runMoveSuite("GrpcHttpClient (browser, binary)", {
  client: () => new GrpcHttpClient({ url: serverUrl(), codec, binary: true }),
});

setupHarness();
