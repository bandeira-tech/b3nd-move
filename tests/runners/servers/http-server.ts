/**
 * HTTP transport factory for browser integration tests.
 *
 * Boots the *real* `httpApi(rig)` + `withCors` on an ephemeral port,
 * backed by the stub rig — i.e. the browser-side `HttpClient` hits
 * the same code path that ships to real deployments. Only the rig is
 * stubbed.
 */

/// <reference lib="deno.ns" />

import { httpApi } from "../../../src/http/service.ts";
import { withCors } from "../../../src/cors.ts";
import type { StubServerHandle } from "../browser-runner.ts";
import { stubRig } from "../stub-rig.ts";

export function startHttpServer(): Promise<StubServerHandle> {
  const rig = stubRig();
  const handler = withCors(httpApi(rig), { origin: "*" });
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    handler,
  );
  const { port } = server.addr as Deno.NetAddr;
  return Promise.resolve({
    url: `http://127.0.0.1:${port}`,
    stop: () => server.shutdown(),
  });
}
