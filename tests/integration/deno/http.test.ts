/**
 * HTTP — in-Deno integration: real `httpApi` + real `HttpClient`
 * against `stubRig` (canned responses). Drives `runMoveSuite` to
 * assert wire fidelity — that calls reach the rig with the expected
 * shape and that responses survive the encode/transport/decode round.
 */

/// <reference lib="deno.ns" />

import { runMoveSuite } from "../../suites/move-suite.ts";
import { startHttpServer } from "../../factories/http.ts";
import { stubRig } from "../../rigs/stub.ts";
import { HttpClient } from "../../../src/http/client.ts";

const server = await startHttpServer(stubRig());

runMoveSuite("http", {
  client: () => new HttpClient({ url: server.url }),
});

Deno.test({
  name: "[http] teardown",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => server.stop(),
});
