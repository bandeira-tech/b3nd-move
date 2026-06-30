/**
 * @module
 * CORS as an upstream wrapper around any fetch handler.
 *
 * CORS is not internal to the API — it's an HTTP concern that lives
 * *in front of* the handler. The service factories know nothing about
 * it; the operator composes it at their setup site and parametrizes it
 * per deployment:
 *
 * ```ts
 * import { withCors } from "@bandeira-tech/b3nd-move/cors";
 * Deno.serve(
 *   { port: 3000 },
 *   withCors(httpApi(rig, { codec }), { origin: "https://app.example.com" }),
 * );
 * ```
 *
 * `origin` is required (use `"*"` for any); `methods`, `headers`, and
 * `maxAge` default to a sensible set and can be overridden.
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
 * - `OPTIONS` requests get a `204` preflight carrying the configured headers.
 * - Every other response passes through with the CORS headers merged in.
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
