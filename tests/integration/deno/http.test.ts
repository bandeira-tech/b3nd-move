/**
 * HTTP — in-Deno integration: real `httpApi` + real `HttpClient`
 * against a `MemoryStore`-backed rig. Drives the shared
 * `pinContract` round-trip suite.
 */

/// <reference lib="deno.ns" />

import { pinContract } from "../../suites/pin-contract.ts";
import { startHttpServer } from "../../factories/http.ts";
import { memoryRig } from "../../rigs/memory.ts";
import { HttpClient } from "../../../src/http/client.ts";

// Known upstream resource quirk: core's `httpApi` SSE handler installs
// a 30s keepalive `setInterval` whose `clearInterval` lives in the
// stream's `cancel` callback. Deno's per-test sanitizer fires before
// the server-side stream cancel resolves, so observe tests see a
// false-positive op leak. The fix is upstream — bind the cleanup to
// `req.signal` in `@bandeira-tech/b3nd-core/libs/b3nd-rig/http.ts`.
// Drop `sanitizeOps: false` once that lands.
pinContract("http", async () => {
  const server = await startHttpServer(memoryRig());
  const client = new HttpClient({ url: server.url });
  return { client, cleanup: () => Promise.resolve(server.stop()) };
}, { sanitizeOps: false, sanitizeResources: false });
