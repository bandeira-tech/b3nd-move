// deno-lint-ignore-file no-import-prefix
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

import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@^1.0.0/server/stdio.js";
import type { Rig } from "@bandeira-tech/b3nd-core";
import { httpApi } from "../src/http/service.ts";
import { httpOutputsFrame } from "../src/codecs/http/mod.ts";
import { wsApi } from "../src/ws/service.ts";
import { wsJsonEnvelope } from "../src/codecs/ws/mod.ts";
import { grpcHttpApi } from "../src/grpc/http/service.ts";
import { grpcProto } from "../src/codecs/grpc/mod.ts";
import { buildMcpServer, type McpServerOptions } from "../src/mcp/service.ts";
import { mcpHttpApi } from "../src/mcp/http/service.ts";
import { mcpWsApi } from "../src/mcp/ws/service.ts";
import { mcpTextJsonStringify } from "../src/codecs/mcp/mod.ts";

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
  | { transport: "mcp"; name?: string; version?: string }
  | {
    transport: "mcp-http";
    port?: number;
    hostname?: string;
    name?: string;
    version?: string;
  }
  | {
    transport: "mcp-ws";
    port?: number;
    hostname?: string;
    name?: string;
    version?: string;
  };

const HTTP_DEFAULTS = { port: 3000, hostname: "0.0.0.0" } as const;
const WS_DEFAULTS = { port: 8080, hostname: "0.0.0.0" } as const;
const GRPC_DEFAULTS = { port: 50051, hostname: "0.0.0.0" } as const;
const MCP_HTTP_DEFAULTS = { port: 3001, hostname: "0.0.0.0" } as const;
const MCP_WS_DEFAULTS = { port: 8081, hostname: "0.0.0.0" } as const;

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
    case "mcp-http":
      return mcpHttpTransport(rig, config);
    case "mcp-ws":
      return mcpWsTransport(rig, config);
  }
}

function httpTransport(
  rig: Rig,
  c: Extract<ServerConfig, { transport: "http" }>,
): TransportServer {
  const port = c.port ?? HTTP_DEFAULTS.port;
  const hostname = c.hostname ?? HTTP_DEFAULTS.hostname;
  const handler = httpApi(rig, {
    codec: httpOutputsFrame(),
    statusMeta: c.statusMeta,
  });
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
  const attach = wsApi(rig, { codec: wsJsonEnvelope() });
  const sockets = new Set<WebSocket>();
  const handler = (req: Request): Response => {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("Not Found", { status: 404 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    sockets.add(socket);
    socket.addEventListener(
      "close",
      () => sockets.delete(socket),
      { once: true },
    );
    attach(socket);
    return response;
  };
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
      await drainSockets(sockets);
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
  const handler = grpcHttpApi(rig, { codec: grpcProto() });
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
  const opts: McpServerOptions = { codec: mcpTextJsonStringify() };
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

function mcpHttpTransport(
  rig: Rig,
  c: Extract<ServerConfig, { transport: "mcp-http" }>,
): TransportServer {
  const port = c.port ?? MCP_HTTP_DEFAULTS.port;
  const hostname = c.hostname ?? MCP_HTTP_DEFAULTS.hostname;
  const opts: McpServerOptions = { codec: mcpTextJsonStringify() };
  if (c.name) opts.name = c.name;
  if (c.version) opts.version = c.version;
  const handler = mcpHttpApi(rig, opts);
  let server: Deno.HttpServer | null = null;
  return {
    transport: "mcp-http",
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

function mcpWsTransport(
  rig: Rig,
  c: Extract<ServerConfig, { transport: "mcp-ws" }>,
): TransportServer {
  const port = c.port ?? MCP_WS_DEFAULTS.port;
  const hostname = c.hostname ?? MCP_WS_DEFAULTS.hostname;
  const opts: McpServerOptions = { codec: mcpTextJsonStringify() };
  if (c.name) opts.name = c.name;
  if (c.version) opts.version = c.version;
  const attach = mcpWsApi(rig, opts);
  const sockets = new Set<WebSocket>();
  const handler = (req: Request): Response => {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("Not Found", { status: 404 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req, {
      protocol: "mcp",
    });
    sockets.add(socket);
    socket.addEventListener(
      "close",
      () => sockets.delete(socket),
      { once: true },
    );
    attach(socket);
    return response;
  };
  let server: Deno.HttpServer | null = null;
  return {
    transport: "mcp-ws",
    address: `ws://${hostname}:${port}`,
    start() {
      server = Deno.serve({ port, hostname }, handler);
      return Promise.resolve();
    },
    async stop() {
      // Drain WS connections first — Deno.HttpServer.shutdown waits
      // for in-flight requests, and WS connections are long-lived.
      await drainSockets(sockets);
      if (server) {
        await server.shutdown();
        server = null;
      }
    },
  };
}

/**
 * Close every still-open socket and wait for their close handshake.
 * Used by `ws` and `mcp-ws` transports before stopping the listener.
 */
function drainSockets(sockets: Set<WebSocket>): Promise<void> {
  const waits: Promise<void>[] = [];
  for (const socket of sockets) {
    if (
      socket.readyState === WebSocket.CLOSED ||
      socket.readyState === WebSocket.CLOSING
    ) continue;
    waits.push(
      new Promise<void>((resolve) => {
        const done = () => resolve();
        socket.addEventListener("close", done, { once: true });
        socket.addEventListener("error", done, { once: true });
        try {
          socket.close(1001, "server shutting down");
        } catch {
          resolve();
        }
      }),
    );
  }
  return Promise.all(waits).then(() => {});
}
