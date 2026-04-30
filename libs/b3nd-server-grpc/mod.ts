/**
 * @module
 * gRPC transport as a ServerResolver.
 *
 * Serves the B3ndService over HTTP/2 via `Deno.serve` using the Connect
 * protocol (JSON over HTTP/2). No protobuf codegen required. CORS can
 * be set per-server (`grpcServer({ cors })`) or once at the composition
 * level (`createServers(rig, [...], { cors })`); per-server wins.
 *
 * @example
 * ```typescript
 * import { Rig, createServers } from "@bandeira-tech/b3nd-core";
 * import { grpcServer } from "@bandeira-tech/b3nd-grpc";
 *
 * const servers = createServers(rig, [grpcServer({ port: 50051 })], {
 *   cors: "*",
 * });
 * await Promise.all(servers.map((s) => s.start()));
 * ```
 */

import type { Rig } from "@bandeira-tech/b3nd-core";
import { withCors } from "../b3nd-cors/mod.ts";
import type {
  ServerComposition,
  ServerResolver,
  TransportServer,
} from "../b3nd-server-factory/mod.ts";
import { grpcApi } from "./service.ts";

export interface GrpcServerOptions {
  /** Port to listen on. Default: 50051. */
  port?: number;
  /** Hostname to bind. Default: "0.0.0.0". */
  hostname?: string;
  /** CORS origin. Overrides composition `cors`. Falsy = no CORS. */
  cors?: string;
}

/**
 * Create a gRPC ServerResolver.
 *
 * The returned resolver, when given a rig, produces a `TransportServer`
 * that serves the B3ndService over HTTP/2 using the Connect protocol.
 */
export function grpcServer(options?: GrpcServerOptions): ServerResolver {
  return {
    transport: "grpc",
    create(rig: Rig, composition?: ServerComposition): TransportServer {
      const port = options?.port ?? 50051;
      const hostname = options?.hostname ?? "0.0.0.0";
      const corsOrigin = options?.cors ?? composition?.cors;

      const baseHandler = grpcApi(rig);
      const handler = corsOrigin
        ? withCors(baseHandler, { origin: corsOrigin })
        : baseHandler;

      let server: Deno.HttpServer | null = null;

      return {
        transport: "grpc",
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
    },
  };
}

export { grpcApi } from "./service.ts";
