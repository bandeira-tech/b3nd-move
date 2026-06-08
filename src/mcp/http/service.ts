/**
 * @module
 * MCP service over HTTP — `mcpHttpApi(rig)` as a fetch handler that speaks
 * the MCP Streamable HTTP transport (spec revision 2025-03-26) against a
 * `Rig`.
 *
 * Wire protocol:
 *
 *   POST   /…  JSON-RPC message or batch in body; reply is either
 *              `application/json` (unary) or `text/event-stream` (SSE
 *              frames terminated by the server). The first response to
 *              `initialize` carries an `Mcp-Session-Id` header; clients
 *              echo it on subsequent requests.
 *   GET    /…  Opens an SSE stream for server→client notifications
 *              outside of a request/response pair. Keyed by
 *              `Mcp-Session-Id`.
 *   DELETE /…  Terminates the session.
 *
 * The transport — `WebStandardStreamableHTTPServerTransport` from the MCP
 * SDK — is per-session, in-memory state. Each `initialize` mints a new
 * transport + a fresh `Server` (via `buildMcpServer`) and stashes them
 * in an internal `Map<sessionId, Transport>`. Subsequent requests look
 * up the transport by header.
 *
 * The path is not part of this module's surface — the handler treats
 * any inbound `Request` as MCP traffic. Composers route by path:
 *
 *     if (url.pathname.startsWith("/api/v1/mcp")) return mcp(req);
 *
 * Standalone use (`Deno.serve(mcpHttpApi(rig))`) just makes every URL
 * an MCP endpoint, which is fine for a dev server.
 *
 * Cross-isolate hosts: this handler holds session state in an isolate-
 * local Map. On Cloudflare Workers, route all requests for a given
 * `Mcp-Session-Id` to a single Durable Object that wraps
 * `mcpHttpApi(rig)`, or run in stateless mode by reconnecting per
 * request (one POST → one transport → discard).
 *
 * @example
 * ```ts
 * import { Rig, connection } from "@bandeira-tech/b3nd-core";
 * import { mcpHttpApi } from "@bandeira-tech/b3nd-move/mcp/http/service";
 *
 * const c = connection(client, ["**"]);
 * const rig = new Rig({ routes: { receive: [c], read: [c], observe: [c] } });
 * Deno.serve({ port: 3000 }, mcpHttpApi(rig));
 * ```
 *
 * @example Stacked on the same port as httpApi + wsApi
 * ```ts
 * const http = httpApi(rig);
 * const ws   = wsApi(rig);
 * const mcp  = mcpHttpApi(rig);
 * Deno.serve({ port: 3000 }, (req) => {
 *   if (req.headers.get("upgrade") === "websocket") return ws(req);
 *   if (new URL(req.url).pathname.startsWith("/api/v1/mcp")) return mcp(req);
 *   return http(req);
 * });
 * ```
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Rig } from "@bandeira-tech/b3nd-core";
import { buildMcpServer, type McpServerOptions } from "../service.ts";

const SESSION_HEADER = "mcp-session-id";

/**
 * Create an MCP request handler backed by a Rig, speaking the Streamable
 * HTTP transport. Returns a `(Request) => Promise<Response>` compatible
 * with `Deno.serve`, Hono, or any web-standard host (including
 * Cloudflare Workers).
 *
 * `opts` is forwarded to `buildMcpServer` — controls the server name
 * and version reported in `initialize`.
 */
export function mcpHttpApi(
  rig: Rig,
  opts?: McpServerOptions,
): (req: Request) => Promise<Response> {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  return async (req: Request): Promise<Response> => {
    const sessionId = req.headers.get(SESSION_HEADER) ?? undefined;
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    if (existing) {
      return existing.handleRequest(req);
    }

    // No known session — either this is an `initialize` POST (the
    // transport will mint a session id and call `onsessioninitialized`),
    // or it's a stray request with a stale/missing header (the
    // transport will return 400/404 itself).
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid: string) => {
        sessions.set(sid, transport);
      },
      onsessionclosed: (sid: string) => {
        sessions.delete(sid);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const server = buildMcpServer(rig, opts);
    await server.connect(transport);
    return transport.handleRequest(req);
  };
}
