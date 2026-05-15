/**
 * Local-dev convenience: spin up b3nd-move transports against a rig.
 *
 * Lives outside `src/` because runtime binding (`Deno.serve`, stdio,
 * `closeAll()` drain) is not part of the move layer's public surface.
 * Production runners and SDKs build their own equivalents tuned to
 * their host runtime; this file exists so `deno task serve` and ad-hoc
 * scripts have one obvious helper to reach for.
 *
 * @example
 * ```typescript
 * import { serve } from "../dev/serve.ts";
 *
 * const servers = [
 *   serve(rig, { transport: "http", port: 3000 }),
 *   serve(rig, { transport: "ws", port: 8080 }),
 * ];
 * await Promise.all(servers.map((s) => s.start()));
 * ```
 */

/// <reference lib="deno.ns" />

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Rig } from "@bandeira-tech/b3nd-core";
import { httpApi } from "../src/http/service.ts";
import { wsApi } from "../src/ws/service.ts";
import { grpcHttpApi } from "../src/grpc/http/service.ts";
import { buildMcpServer, type McpServerOptions } from "../src/mcp/service.ts";

export interface TransportServer {
  readonly transport: string;
  readonly address: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type ServerConfig =
  | {
    transport: "http";
    port?: number;
    hostname?: string;
    statusMeta?: Record<string, unknown>;
  }
  | { transport: "ws"; port?: number; hostname?: string }
  | { transport: "grpc-http"; port?: number; hostname?: string }
  | { transport: "mcp"; name?: string; version?: string };

const HTTP_DEFAULTS = { port: 3000, hostname: "0.0.0.0" } as const;
const WS_DEFAULTS = { port: 8080, hostname: "0.0.0.0" } as const;
const GRPC_DEFAULTS = { port: 50051, hostname: "0.0.0.0" } as const;

/** Build a transport server bound to the rig; not yet started. */
export function serve(rig: Rig, config: ServerConfig): TransportServer {
  switch (config.transport) {
    case "http":
      return httpTransport(rig, config);
    case "ws":
      return wsTransport(rig, config);
    case "grpc-http":
      return grpcHttpTransport(rig, config);
    case "mcp":
      return mcpTransport(rig, config);
  }
}

function httpTransport(
  rig: Rig,
  c: Extract<ServerConfig, { transport: "http" }>,
): TransportServer {
  const port = c.port ?? HTTP_DEFAULTS.port;
  const hostname = c.hostname ?? HTTP_DEFAULTS.hostname;
  const handler = httpApi(rig, { statusMeta: c.statusMeta });
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

function wsTransport(
  rig: Rig,
  c: Extract<ServerConfig, { transport: "ws" }>,
): TransportServer {
  const port = c.port ?? WS_DEFAULTS.port;
  const hostname = c.hostname ?? WS_DEFAULTS.hostname;
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
      // Drain WS connections first — Deno.HttpServer.shutdown waits
      // for in-flight requests, and WS connections are long-lived.
      await handler.closeAll();
      if (server) {
        await server.shutdown();
        server = null;
      }
    },
  };
}

function grpcHttpTransport(
  rig: Rig,
  c: Extract<ServerConfig, { transport: "grpc-http" }>,
): TransportServer {
  const port = c.port ?? GRPC_DEFAULTS.port;
  const hostname = c.hostname ?? GRPC_DEFAULTS.hostname;
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

function mcpTransport(
  rig: Rig,
  c: Extract<ServerConfig, { transport: "mcp" }>,
): TransportServer {
  const opts: McpServerOptions = {};
  if (c.name) opts.name = c.name;
  if (c.version) opts.version = c.version;
  let transport: StdioServerTransport | null = null;
  return {
    transport: "mcp",
    address: "stdio",
    async start() {
      const server = buildMcpServer(rig, opts);
      transport = new StdioServerTransport();
      await server.connect(transport);
    },
    async stop() {
      await transport?.close();
      transport = null;
    },
  };
}
