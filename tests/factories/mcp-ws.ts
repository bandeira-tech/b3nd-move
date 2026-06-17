// deno-lint-ignore-file no-import-prefix
/**
 * MCP-over-WS transport factory for integration tests.
 *
 * Owns the upgrade (`Deno.upgradeWebSocket` with the `mcp` subprotocol
 * that the SDK client requires) and the drain set; calls `mcpWsApi`
 * to attach the MCP server to each socket. Returns the same
 * `{ client, cleanup }` shape as the other MCP factories so the shared
 * `mcpSpec` suite can drive WS too.
 */

/// <reference lib="deno.ns" />

import { Client } from "npm:@modelcontextprotocol/sdk@^1.0.0/client/index.js";
import { WebSocketClientTransport } from "npm:@modelcontextprotocol/sdk@^1.0.0/client/websocket.js";
import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import { mcpWsApi } from "../../src/mcp/ws/service.ts";

export interface McpWsHandle {
  client: Client;
  cleanup: () => Promise<void>;
}

export async function startMcpOverWs(rig: Rig): Promise<McpWsHandle> {
  const attach = mcpWsApi(rig, { name: "b3nd-mcp-test", version: "0.0.0" });
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
  const server = Deno.serve({ port: 0, onListen: () => {} }, handler);
  const { hostname, port } = server.addr as Deno.NetAddr;
  const url = new URL(`ws://${hostname}:${port}/`);

  const client = new Client({
    name: "b3nd-mcp-test-client",
    version: "0.0.0",
  });
  await client.connect(new WebSocketClientTransport(url));

  return {
    client,
    cleanup: async () => {
      await client.close();
      await drain(sockets);
      await server.shutdown();
    },
  };
}

function drain(sockets: Set<WebSocket>): Promise<void> {
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
          socket.close(1001, "test teardown");
        } catch {
          resolve();
        }
      }),
    );
  }
  return Promise.all(waits).then(() => {});
}
