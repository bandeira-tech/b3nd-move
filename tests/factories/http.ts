/**
 * HTTP transport factory for integration tests.
 *
 * Boots `httpApi(rig)` on an ephemeral loopback port. Caller supplies
 * the rig (see `tests/rigs/`) and constructs whatever client they
 * want pointed at the returned `url`. `cors: true` flips the service's
 * own operator-declared CORS knob for cross-origin browser callers.
 */

/// <reference lib="deno.ns" />

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import type { HttpBatchCodec } from "../../src/http/codec.ts";
import { httpApi } from "../../src/http/service.ts";

export interface ServerHandle {
  /** Base URL the client should point at. */
  url: string;
  /** Tear down the server. */
  stop: () => Promise<void> | void;
}

export interface HttpServerOptions {
  /** Operator-declared codec for read responses + receive bodies. Required. */
  codec: HttpBatchCodec;
  /** Operator-declared CORS (permissive `*`). Default: false. */
  cors?: boolean;
}

export function startHttpServer(
  rig: Rig,
  opts: HttpServerOptions,
): Promise<ServerHandle> {
  const handler = httpApi(rig, { codec: opts.codec, cors: opts.cors });
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
