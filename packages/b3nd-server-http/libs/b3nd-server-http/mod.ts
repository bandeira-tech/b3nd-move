/**
 * @module
 * HTTP transport as a ServerResolver.
 *
 * Wraps the existing `httpApi()` with Hono for CORS, port binding,
 * and lifecycle management.
 *
 * @example
 * ```typescript
 * import { Rig, createServers } from "@bandeira-tech/b3nd-core";
 * import { httpServer } from "@bandeira-tech/b3nd-server-http";
 *
 * const servers = createServers(rig, [
 *   httpServer({ port: 3000, cors: "*" }),
 * ]);
 * await Promise.all(servers.map((s) => s.start()));
 * ```
 */

import {
  httpApi,
  type HttpApiOptions,
  type Rig,
  type ServerResolver,
  type TransportServer,
} from "@bandeira-tech/b3nd-core";

export interface HttpServerOptions extends HttpApiOptions {
  /** Port to listen on. Default: 3000. */
  port?: number;
  /** Hostname to bind. Default: "0.0.0.0". */
  hostname?: string;
  /** CORS origin. Falsy = no CORS middleware. */
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
    create(rig: Rig): TransportServer {
      const port = options?.port ?? 3000;
      const hostname = options?.hostname ?? "0.0.0.0";
      const corsOrigin = options?.cors;
      const apiOptions: HttpApiOptions = {
        statusMeta: options?.statusMeta,
      };

      const handler = httpApi(rig, apiOptions);

      let server: Deno.HttpServer | null = null;

      return {
        transport: "http",
        address: `http://${hostname}:${port}`,

        async start() {
          // Dynamic import — keeps Hono as a lazy dependency
          const { Hono } = await import("hono");
          const app = new Hono();

          if (corsOrigin) {
            const { cors } = await import("hono/cors");
            app.use("*", cors({ origin: corsOrigin }));
          }

          // deno-lint-ignore no-explicit-any
          app.all("/api/*", (c: any) => handler(c.req.raw));

          server = Deno.serve({ port, hostname }, app.fetch);
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
