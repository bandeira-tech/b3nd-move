/**
 * @module
 * CORS middleware for HTTP request handlers.
 *
 * Wraps a `(Request) => Promise<Response>` handler with CORS headers
 * and an OPTIONS preflight responder. Used by transport servers in
 * this package; also exported for ad-hoc use around `httpApi(rig)`
 * from `@bandeira-tech/b3nd-move/http/api`.
 *
 * @example
 * ```ts
 * import { httpApi } from "@bandeira-tech/b3nd-move/http/api";
 * import { withCors } from "@bandeira-tech/b3nd-move";
 *
 * const handler = withCors(httpApi(rig), { origin: "*" });
 * Deno.serve({ port: 3000 }, handler);
 * ```
 */

export interface CorsOptions {
  /** Allowed origin. Use `"*"` for any. Required. */
  origin: string;
  /** Allowed methods. Default: `"GET, POST, PUT, DELETE, OPTIONS"`. */
  methods?: string;
  /** Allowed headers. Default: `"Content-Type, Authorization, Last-Event-ID"`. */
  headers?: string;
  /** Preflight cache seconds. Default: `86400`. */
  maxAge?: number;
}

type Handler = (req: Request) => Promise<Response>;

function buildHeaders(options: CorsOptions): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": options.origin,
    "Access-Control-Allow-Methods": options.methods ??
      "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": options.headers ??
      "Content-Type, Authorization, Last-Event-ID",
    "Access-Control-Max-Age": String(options.maxAge ?? 86400),
  };
}

/**
 * Wrap a request handler with CORS support.
 *
 * - `OPTIONS` requests get a 204 preflight response with the configured headers.
 * - All other responses are passed through with CORS headers merged in.
 */
export function withCors(handler: Handler, options: CorsOptions): Handler {
  const headers = buildHeaders(options);
  return async (req) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    const res = await handler(req);
    const merged = new Headers(res.headers);
    for (const [k, v] of Object.entries(headers)) merged.set(k, v);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: merged,
    });
  };
}
