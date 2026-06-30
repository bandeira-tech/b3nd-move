/**
 * @module
 * MCP service over HTTP — `mcpHttpApi(rig)` as a fetch handler that
 * speaks the MCP Streamable HTTP transport against a `Rig`.
 *
 * Stateless by design. Every POST creates a fresh transport + fresh
 * `MinimalServer`, dispatches the request, returns the response. No
 * `Mcp-Session-Id`, no per-isolate session map, no DELETE
 * teardown — there's nothing to tear down. The b3nd MCP surface is
 * pure request/response (tools/list, tools/call, resources/list,
 * resources/read) and carries zero per-session state, so the session
 * concept buys us nothing and would only force sticky routing on
 * multi-isolate hosts (Vercel Edge, Deno Deploy, Cloudflare Workers
 * across DOs).
 *
 * The MCP spec (2025-06-18) makes `Mcp-Session-Id` server-optional:
 * "A server using the Streamable HTTP transport **MAY** assign a
 * session ID at initialization time" — we just don't. The
 * 2026-07-28 RC removes sessions from the protocol entirely, which
 * is the same wire shape we ship here.
 *
 * Wire protocol on the server side:
 *
 *   POST   /…  JSON-RPC message in body; reply is either
 *              `application/json` (unary) or `text/event-stream`
 *              (SSE frames terminated by the server).
 *   GET    /…  405 Method Not Allowed (no standalone GET stream).
 *   DELETE /…  405 Method Not Allowed (no session to terminate).
 *
 * The path is not part of this module's surface — the handler treats
 * any inbound `Request` as MCP traffic. Composers route by path:
 *
 *     if (url.pathname.startsWith("/api/v1/mcp")) return mcp(req);
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
 * import { httpOutputsFrame } from "@bandeira-tech/b3nd-move/codecs/http";
 * import { wsJsonEnvelope } from "@bandeira-tech/b3nd-move/codecs/ws";
 * import { mcpTextJsonStringify } from "@bandeira-tech/b3nd-move/codecs/mcp";
 *
 * const http = httpApi(rig, { codec: httpOutputsFrame() });
 * const ws   = wsApi(rig, { codec: wsJsonEnvelope() });
 * const mcp  = mcpHttpApi(rig, { codec: mcpTextJsonStringify() });
 * Deno.serve({ port: 3000 }, (req) => {
 *   if (req.headers.get("upgrade") === "websocket") return ws(req);
 *   if (new URL(req.url).pathname.startsWith("/api/v1/mcp")) return mcp(req);
 *   return http(req);
 * });
 * ```
 */

import { WebStandardStreamableHTTPServerTransport } from "../web-streamable-http-transport.ts";
import type { Rig } from "@bandeira-tech/b3nd-core";
import { buildMcpServer, type McpServerOptions } from "../service.ts";

/**
 * Create an MCP request handler backed by a Rig, speaking the
 * Streamable HTTP transport in stateless mode. Returns a
 * `(Request) => Promise<Response>` compatible with `Deno.serve`,
 * Hono, or any web-standard host (Cloudflare Workers, Vercel Edge,
 * Deno Deploy, Bun, …).
 *
 * `opts` is forwarded to `buildMcpServer` — controls the server name
 * and version reported in `initialize`.
 */
export function mcpHttpApi(
  rig: Rig,
  opts: McpServerOptions,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    // Fresh transport + server per request. `sessionIdGenerator:
    // undefined` puts the transport into stateless mode: no session
    // ID returned, no session validation on subsequent requests
    // (there are none — each call is self-contained).
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = buildMcpServer(rig, opts);
    await server.connect(transport);
    return transport.handleRequest(req);
  };
}
