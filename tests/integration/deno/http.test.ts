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

const enc = new TextEncoder();
runMoveSuite("http", {
  client: () => new HttpClient({ url: server.url }),
  // HTTP wire is opaque bytes past the URL — encode JS payloads once
  // at the producer's edge before they cross the wire. The stub rig
  // ignores payload content; this is purely for what the wire needs.
  payload: (v) => enc.encode(JSON.stringify(v)),
});

Deno.test({
  name: "[http] teardown",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => server.stop(),
});
