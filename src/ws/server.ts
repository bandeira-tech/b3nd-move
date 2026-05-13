/**
 * @module
 * WebSocket transport as a ServerResolver (Deno-only).
 *
 * Wraps `wsApi()` with `withCors()` + `Deno.serve`. CORS can be set per
 * server (`wsServer({ cors })`) or once at composition level
 * (`createServers(rig, [...], { cors })`), with per-server taking
 * precedence.
 *
 * @example
 * ```typescript
 * import { Rig, createServers } from "@bandeira-tech/b3nd-move";
 * import { wsServer } from "@bandeira-tech/b3nd-move/ws";
 *
 * const servers = createServers(rig, [wsServer({ port: 8080 })], {
 *   cors: "*",
 * });
 * await Promise.all(servers.map((s) => s.start()));
 * ```
 */

import type { Rig } from "@bandeira-tech/b3nd-core";
import { withCors } from "../cors.ts";
import type {
  ServerComposition,
  ServerResolver,
  TransportServer,
} from "../factory.ts";
import { wsApi } from "./service.ts";

export interface WsServerOptions {
  /** Port to listen on. Default: 8080. */
  port?: number;
  /** Hostname to bind. Default: "0.0.0.0". */
  hostname?: string;
  /** CORS origin. Overrides composition `cors`. Falsy = no CORS. */
  cors?: string;
}

export function wsServer(options?: WsServerOptions): ServerResolver {
  return {
    transport: "ws",
    create(rig: Rig, composition?: ServerComposition): TransportServer {
      const port = options?.port ?? 8080;
      const hostname = options?.hostname ?? "0.0.0.0";
      const corsOrigin = options?.cors ?? composition?.cors;

      const baseHandler = wsApi(rig);
      const handler = corsOrigin
        ? withCors(baseHandler, { origin: corsOrigin })
        : baseHandler;

      let server: Deno.HttpServer | null = null;

      return {
        transport: "ws",
        address: `ws://${hostname}:${port}`,
        start() {
          server = Deno.serve({ port, hostname }, handler);
          return Promise.resolve();
        },
        async stop() {
          // Close active WS connections first — Deno.HttpServer.shutdown
          // waits for in-flight requests but WS connections are
          // long-lived and would otherwise block forever.
          await baseHandler.closeAll();
          if (server) {
            await server.shutdown();
            server = null;
          }
        },
      };
    },
  };
}
