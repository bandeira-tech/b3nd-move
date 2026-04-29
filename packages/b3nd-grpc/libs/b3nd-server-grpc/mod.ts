/**
 * @module
 * gRPC transport as a ServerResolver.
 *
 * Serves the B3ndService over HTTP/2 via Deno.serve using the
 * Connect protocol (JSON over HTTP/2). No protobuf codegen required.
 *
 * @example
 * ```typescript
 * import { Rig, createServers } from "@b3nd/rig";
 * import { grpcServer } from "@b3nd/server-grpc";
 *
 * const servers = createServers(rig, [
 *   grpcServer({ port: 50051 }),
 * ]);
 * await Promise.all(servers.map(s => s.start()));
 * ```
 */

import type {
  Rig,
  ServerResolver,
  TransportServer,
} from "@bandeira-tech/b3nd-core";
import { createGrpcHandler } from "./service.ts";

export interface GrpcServerOptions {
  /** Port to listen on. Default: 50051. */
  port?: number;
  /** Hostname to bind. Default: "0.0.0.0". */
  hostname?: string;
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
    create(rig: Rig): TransportServer {
      const port = options?.port ?? 50051;
      const hostname = options?.hostname ?? "0.0.0.0";
      const handler = createGrpcHandler(rig);

      let server: Deno.HttpServer | null = null;

      return {
        transport: "grpc",
        address: `http://${hostname}:${port}`,

        async start() {
          server = Deno.serve({ port, hostname }, handler);
          // Deno.serve starts immediately — no await needed for listen
          await Promise.resolve();
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

export { createGrpcHandler } from "./service.ts";
