/**
 * @module
 * gRPC-HTTP transport bound to `Deno.serve` (Deno-only).
 *
 * Wraps `grpcHttpApi()` with `Deno.serve`. CORS is intentionally not a knob
 * here — wrap `grpcHttpApi(rig)` and `Deno.serve` yourself if you need
 * middleware, or use a higher-level SDK that bundles the conveniences.
 *
 * @example
 * ```typescript
 * import { grpcHttpServer } from "@bandeira-tech/b3nd-move/grpc/http/server";
 *
 * const server = grpcHttpServer(rig, { port: 50051 });
 * await server.start();
 * ```
 */

import type { Rig } from "@bandeira-tech/b3nd-core";
import { grpcHttpApi } from "./service.ts";

export interface TransportServer {
  readonly transport: string;
  readonly address: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface GrpcHttpServerOptions {
  /** Port to listen on. Default: 50051. */
  port?: number;
  /** Hostname to bind. Default: "0.0.0.0". */
  hostname?: string;
}

export function grpcHttpServer(
  rig: Rig,
  options?: GrpcHttpServerOptions,
): TransportServer {
  const port = options?.port ?? 50051;
  const hostname = options?.hostname ?? "0.0.0.0";

  const handler = grpcHttpApi(rig);

  let server: Deno.HttpServer | null = null;

  return {
    transport: "grpc-http",
    address: `http://${hostname}:${port}`,
    start() {
      server = Deno.serve({ port, hostname }, handler);
      return Promise.resolve();
    },
    async stop() {
      if (server) {
        await server.shutdown();
        server = null;
      }
    },
  };
}
