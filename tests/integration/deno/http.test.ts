/**
 * HTTP — in-Deno integration: real `httpApi` + real `HttpClient`
 * against the stub rig. Drives the shared `moveSuite` — same suite
 * as the browser run, just with a Deno-resident client.
 *
 * The rig+store integration lives in `@bandeira-tech/b3nd-stores`;
 * here we only verify that the move layer (encode → transport →
 * decode) carries values faithfully across the network boundary.
 */

/// <reference lib="deno.ns" />

import { runMoveSuite } from "../../suites/move-suite.ts";
import { startHttpServer } from "../../factories/http.ts";
import { stubRig } from "../../rig.ts";
import { HttpClient } from "../../../src/http/client.ts";

const server = await startHttpServer(stubRig());

runMoveSuite("HttpClient (deno)", {
  client: () => new HttpClient({ url: server.url }),
});

// Runs last by registration order — tears down the shared server.
Deno.test({
  name: "HttpClient (deno) — cleanup",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => Promise.resolve(server.stop()),
});
