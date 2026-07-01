/**
 * @module
 * MCP service over WebSocket — `mcpWsApi(rig, opts)` returns a function that
 * attaches a fresh `buildMcpServer(rig, opts)` (wired via
 * `WebSocketServerTransport`) to an already-open `WebSocket`. The host
 * owns the upgrade (`Deno.upgradeWebSocket`, CF's `WebSocketPair`,
 * Node's `ws`) and any cross-socket lifecycle; the library only knows
 * about one socket at a time.
 *
 * Wire framing (see `./transport.ts`): one JSON-RPC message per frame,
 * no session header — the connection IS the session. MCP has no
 * official WS transport spec; this matches the JSON-RPC envelope the
 * SDK already uses on stdio.
 *
 * The SDK's `WebSocketClientTransport` requests the `mcp` subprotocol
 * during the handshake. The host should echo it back when accepting
 * the upgrade (e.g. `Deno.upgradeWebSocket(req, { protocol: "mcp" })`,
 * or on CF, pass it to `WebSocketPair` config).
 *
 * Lifecycle: each call to the attacher mints a new
 * `WebSocketServerTransport` + a new `Server` — one socket, one MCP
 * session. When the socket closes, the transport's `onclose` fires and
 * the `Server` connection unwinds. Per-socket state lives only on the
 * stack.
 *
 * @example Deno
 * ```ts
 * import { mcpTextJsonStringify } from "@bandeira-tech/b3nd-move/codecs/mcp";
 *
 * const attach = mcpWsApi(rig, { codec: mcpTextJsonStringify() });
 * Deno.serve({ port: 8080 }, (req) => {
 *   if (req.headers.get("upgrade") !== "websocket") {
 *     return new Response("Not Found", { status: 404 });
 *   }
 *   const { socket, response } = Deno.upgradeWebSocket(req, {
 *     protocol: "mcp",
 *   });
 *   attach(socket);
 *   return response;
 * });
 * ```
 *
 * @example Cloudflare Durable Object
 * ```ts
 * import { mcpTextJsonStringify } from "@bandeira-tech/b3nd-move/codecs/mcp";
 *
 * export class B3ndMcpSession {
 *   #attach = mcpWsApi(this.rig, { codec: mcpTextJsonStringify() });
 *   fetch(req: Request) {
 *     const [client, server] = Object.values(
 *       new WebSocketPair(),
 *     );
 *     server.accept();
 *     this.#attach(server);
 *     return new Response(null, {
 *       status: 101,
 *       webSocket: client,
 *       headers: { "Sec-WebSocket-Protocol": "mcp" },
 *     });
 *   }
 * }
 * ```
 */

import type { ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core/types";
import { buildMcpServer, type McpServerOptions } from "../service.ts";
import { WebSocketServerTransport } from "./transport.ts";

/**
 * Attach an MCP server to an already-open `WebSocket`. The socket must
 * be in `CONNECTING` or `OPEN`; the listeners are wired immediately and
 * the `Server` reacts to JSON-RPC frames as they arrive.
 */
export type McpWsApi = (socket: WebSocket) => void;

/**
 * Build an MCP WS attacher bound to a Rig. `opts` is forwarded to
 * `buildMcpServer` — controls the server name and version reported in
 * `initialize`.
 */
export function mcpWsApi(
  rig: ProtocolInterfaceNode,
  opts: McpServerOptions,
): McpWsApi {
  return (socket: WebSocket): void => {
    const transport = new WebSocketServerTransport(socket);
    const server = buildMcpServer(rig, opts);
    // `connect` calls `transport.start()` which wires the socket
    // listeners. The attacher returns synchronously; the Server lives
    // until the socket closes (transport.onclose unwinds it).
    void server.connect(transport);
  };
}
