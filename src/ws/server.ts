/**
 * @module
 * WebSocket transport bound to `Deno.serve` (Deno-only).
 *
 * Wraps `wsApi()` with `Deno.serve`. CORS is intentionally not a knob here —
 * WebSocket handshakes are not subject to CORS in browsers, and any HTTP
 * preflight you need can be added by wrapping `wsApi(rig)` yourself.
 *
 * @example
 * ```typescript
 * import { wsServer } from "@bandeira-tech/b3nd-move/ws/server";
 *
 * const server = wsServer(rig, { port: 8080 });
 * await server.start();
 * ```
 */

import type { Rig } from "@bandeira-tech/b3nd-core";
import { wsApi } from "./service.ts";

export interface TransportServer {
  readonly transport: string;
  readonly address: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface WsServerOptions {
  /** Port to listen on. Default: 8080. */
  port?: number;
  /** Hostname to bind. Default: "0.0.0.0". */
  hostname?: string;
}

export function wsServer(
  rig: Rig,
  options?: WsServerOptions,
): TransportServer {
  const port = options?.port ?? 8080;
  const hostname = options?.hostname ?? "0.0.0.0";

  const handler = wsApi(rig);

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
      await handler.closeAll();
      if (server) {
        await server.shutdown();
        server = null;
      }
    },
  };
}
