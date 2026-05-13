/**
 * @module
 * gRPC-HTTP transport as a ServerResolver (Deno-only).
 *
 * @example
 * ```typescript
 * import { createServers } from "@bandeira-tech/b3nd-core";
 * import { grpcHttpServer } from "@bandeira-tech/b3nd-move/grpc/http/server";
 *
 * const servers = createServers(rig, [grpcHttpServer({ port: 50051 })], {
 *   cors: "*",
 * });
 * await Promise.all(servers.map((s) => s.start()));
 * ```
 */

import type { Rig } from "@bandeira-tech/b3nd-core";
import { withCors } from "../../cors.ts";
import type {
  ServerComposition,
  ServerResolver,
  TransportServer,
} from "../../factory.ts";
import { grpcHttpApi } from "./service.ts";

export interface GrpcHttpServerOptions {
  /** Port to listen on. Default: 50051. */
  port?: number;
  /** Hostname to bind. Default: "0.0.0.0". */
  hostname?: string;
  /** CORS origin. Overrides composition `cors`. Falsy = no CORS. */
  cors?: string;
}

export function grpcHttpServer(
  options?: GrpcHttpServerOptions,
): ServerResolver {
  return {
    transport: "grpc-http",
    create(rig: Rig, composition?: ServerComposition): TransportServer {
      const port = options?.port ?? 50051;
      const hostname = options?.hostname ?? "0.0.0.0";
      const corsOrigin = options?.cors ?? composition?.cors;

      const baseHandler = grpcHttpApi(rig);
      const handler = corsOrigin
        ? withCors(baseHandler, { origin: corsOrigin })
        : baseHandler;

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
    },
  };
}
