/**
 * @module
 * In-process gRPC-HTTP factory — boots `grpcHttpApi(rig)` via
 * `Deno.serve` on an ephemeral port and returns a `GrpcHttpClient`
 * configured for the requested encoding.
 *
 * Parametrized over `{ binary }` so the same contract can be registered
 * twice (`grpchttp-json` and `grpchttp-binary`) — the JSON and binary
 * wire paths share the same handler but exercise different codec
 * branches.
 */

import { GrpcHttpClient } from "../../b3nd-client-grpchttp/mod.ts";
import { grpcHttpApi } from "../../b3nd-server-grpchttp/service.ts";
import type { ServerFactory } from "../contract.ts";
import { defaultRig } from "./_rig.ts";

export interface GrpcHttpFactoryOptions {
  /** Use `application/proto` instead of `application/json`. Default: false. */
  binary?: boolean;
}

/**
 * Build a `ServerFactory` for the gRPC-HTTP transport, pinned to the
 * given encoding. Call this once per encoding you want to cover.
 */
export function grpcHttpInProcess(
  opts: GrpcHttpFactoryOptions = {},
): ServerFactory {
  const binary = opts.binary ?? false;
  return () => {
    const rig = defaultRig();
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      grpcHttpApi(rig),
    );
    const { port } = server.addr as Deno.NetAddr;
    const client = new GrpcHttpClient({
      url: `http://127.0.0.1:${port}`,
      binary,
    });
    return Promise.resolve({
      client,
      cleanup: () => server.shutdown(),
    });
  };
}
