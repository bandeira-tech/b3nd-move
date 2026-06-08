/**
 * @module
 * MCP service over WebSocket — `mcpWsApi(rig)` as a fetch handler that
 * upgrades the request to a WebSocket and bridges JSON-RPC frames to a
 * fresh `buildMcpServer(rig)`.
 *
 * Wire framing (see `./transport.ts`): one JSON-RPC message per frame,
 * no session header (the connection IS the session). MCP has no
 * official WS transport spec — this is a minimal, locally-documented
 * mapping that matches the JSON-RPC envelope the SDK already uses on
 * stdio.
 *
 * Lifecycle:
 *   - Each upgrade mints a new `WebSocketServerTransport` + a new
 *     `Server` (via `buildMcpServer`) — one socket, one MCP session.
 *   - When the socket closes (either side), the transport's `onclose`
 *     fires and the Server's `connect` promise unwinds. Per-socket
 *     state lives only on the stack.
 *   - `closeAll()` waits for every open socket to close. Use it from
 *     a transport server's graceful-shutdown path; without it
 *     `Deno.HttpServer.shutdown()` waits forever on long-lived sockets.
 *
 * Non-upgrade requests get a 404 — same shape as `wsApi`. Compose with
 * `httpApi` upstream to share the same port.
 *
 * @example
 * ```ts
 * import { Rig, connection } from "@bandeira-tech/b3nd-core";
 * import { mcpWsApi } from "@bandeira-tech/b3nd-move/mcp/ws/service";
 *
 * const c = connection(client, ["**"]);
 * const rig = new Rig({ routes: { receive: [c], read: [c], observe: [c] } });
 * const handler = mcpWsApi(rig);
 * Deno.serve({ port: 8080 }, handler);
 * // ...later:
 * await handler.closeAll();
 * ```
 */

/// <reference lib="deno.ns" />

import type { Rig } from "@bandeira-tech/b3nd-core";
import { buildMcpServer, type McpServerOptions } from "../service.ts";
import { WebSocketServerTransport } from "./transport.ts";

/**
 * Fetch handler with a `closeAll` lifecycle hook — same shape as
 * `wsApi`, so graceful-shutdown patterns transfer.
 */
export interface McpWsApi {
  (req: Request): Promise<Response>;
  /**
   * Close all currently-open MCP WebSocket connections produced by
   * this handler and wait for their close handshake to settle.
   * Idempotent.
   */
  closeAll(): Promise<void>;
}

/**
 * Create an MCP request handler backed by a Rig, speaking JSON-RPC
 * over WebSocket. `opts` is forwarded to `buildMcpServer` — controls
 * the server name and version reported in `initialize`.
 */
export function mcpWsApi(rig: Rig, opts?: McpServerOptions): McpWsApi {
  const sockets = new Set<WebSocket>();

  const handler = (req: Request): Promise<Response> => {
    if (req.headers.get("upgrade") !== "websocket") {
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }

    // The SDK's `WebSocketClientTransport` opens with the `mcp`
    // subprotocol; echo it back so the handshake succeeds.
    const { socket, response } = Deno.upgradeWebSocket(req, {
      protocol: "mcp",
    });
    sockets.add(socket);
    socket.addEventListener("close", () => {
      sockets.delete(socket);
    }, { once: true });

    socket.addEventListener("open", () => {
      const transport = new WebSocketServerTransport(socket);
      const server = buildMcpServer(rig, opts);
      // `connect` calls `transport.start()`, which wires the socket
      // listeners. We don't await — the handler returns the upgrade
      // response synchronously; the Server lives until the socket
      // closes (transport.onclose unwinds it).
      void server.connect(transport);
    }, { once: true });

    return Promise.resolve(response);
  };

  (handler as McpWsApi).closeAll = (): Promise<void> => {
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
  };

  return handler as McpWsApi;
}
