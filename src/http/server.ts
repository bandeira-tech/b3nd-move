/**
 * @module
 * HTTP transport bound to `Deno.serve`.
 *
 * A no-frills wrapper around `httpApi()` for the common Deno-side case:
 * "give me a `start`/`stop` HTTP server for this rig". CORS is intentionally
 * not a knob here — wrap `httpApi(rig)` and `Deno.serve` yourself if you need
 * middleware, or use a higher-level SDK that bundles the conveniences.
 *
 * @example
 * ```typescript
 * import { httpServer } from "@bandeira-tech/b3nd-move/http/server";
 *
 * const server = httpServer(rig, { port: 3000 });
 * await server.start();
 * ```
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import { httpApi, type HttpApiOptions } from "./service.ts";

export interface TransportServer {
  readonly transport: string;
  readonly address: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface HttpServerOptions extends HttpApiOptions {
  /** Port to listen on. Default: 3000. */
  port?: number;
  /** Hostname to bind. Default: "0.0.0.0". */
  hostname?: string;
}

export function httpServer(
  rig: Rig,
  options?: HttpServerOptions,
): TransportServer {
  const port = options?.port ?? 3000;
  const hostname = options?.hostname ?? "0.0.0.0";
  const handler = httpApi(rig, { statusMeta: options?.statusMeta });

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
}
