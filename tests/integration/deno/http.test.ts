/**
 * HTTP — in-Deno integration: real `httpApi` + real `HttpClient`
 * against an in-process Map-backed rig. Drives the shared
 * `pinContract` round-trip suite.
 */

/// <reference lib="deno.ns" />

import { pinContract } from "../../suites/pin-contract.ts";
import { startHttpServer } from "../../factories/http.ts";
import { testRig } from "../../rigs/memory.ts";
import { HttpClient } from "../../../src/http/client.ts";

pinContract("http", async () => {
  const server = await startHttpServer(testRig());
  const client = new HttpClient({ url: server.url });
  return { client, cleanup: () => Promise.resolve(server.stop()) };
}, { sanitizeOps: false, sanitizeResources: false });
