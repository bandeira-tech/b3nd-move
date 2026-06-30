/**
 * Browser entry for the GrpcHttpClient integration test — JSON
 * encoding (default).
 */

import { serverUrl, setupHarness } from "../deno-stub.ts";
import { GrpcHttpClient } from "../../../src/grpc/http/client.ts";
import { grpcProto } from "../../../src/codecs/grpc/mod.ts";
import { runMoveSuite } from "../../suites/move-suite.ts";

const codec = grpcProto();

runMoveSuite("GrpcHttpClient (browser, json)", {
  client: () => new GrpcHttpClient({ url: serverUrl(), codec }),
});

setupHarness();
