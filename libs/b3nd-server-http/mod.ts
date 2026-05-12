/**
 * @module
 * HTTP transport as a ServerResolver.
 *
 * Wraps `httpApi()` from b3nd-core with `withCors()` + `Deno.serve`.
 * No framework dependency. CORS can be set per-server (`httpServer({ cors })`)
 * or once at the composition level (`createServers(rig, [...], { cors })`),
 * with per-server taking precedence.
 *
 * @example
 * ```typescript
 * import { Rig, createServers } from "@bandeira-tech/b3nd-core";
 * import { httpServer } from "@bandeira-tech/b3nd-server-http";
 *
 * const servers = createServers(rig, [httpServer({ port: 3000 })], {
 *   cors: "*",
 * });
 * await Promise.all(servers.map((s) => s.start()));
 * ```
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import { httpApi, type HttpApiOptions } from "./api.ts";
import { withCors } from "../b3nd-cors/mod.ts";
import type {
  ServerComposition,
  ServerResolver,
  TransportServer,
} from "../b3nd-server-factory/mod.ts";

export interface HttpServerOptions extends HttpApiOptions {
  /** Port to listen on. Default: 3000. */
  port?: number;
  /** Hostname to bind. Default: "0.0.0.0". */
  hostname?: string;
  /** CORS origin. Overrides composition `cors`. Falsy = no CORS. */
  cors?: string;
}

/**
 * Create an HTTP ServerResolver.
 *
 * The returned resolver, when given a rig, produces a `TransportServer`
 * that serves the rig over HTTP with optional CORS.
 */
export function httpServer(options?: HttpServerOptions): ServerResolver {
  return {
    transport: "http",
    create(rig: Rig, composition?: ServerComposition): TransportServer {
      const port = options?.port ?? 3000;
      const hostname = options?.hostname ?? "0.0.0.0";
      const corsOrigin = options?.cors ?? composition?.cors;
      const apiOptions: HttpApiOptions = {
        statusMeta: options?.statusMeta,
      };

      const baseHandler = httpApi(rig, apiOptions);
      const handler = corsOrigin
        ? withCors(baseHandler, { origin: corsOrigin })
        : baseHandler;

      let server: Deno.HttpServer | null = null;

      return {
        transport: "http",
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
