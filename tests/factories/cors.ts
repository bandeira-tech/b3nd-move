/**
 * Tiny CORS wrapper for the browser-driven integration tests.
 *
 * Lives in `tests/` because the public package no longer ships a `withCors` —
 * cross-cutting middleware belongs in the SDK that consumes b3nd-move, not in
 * the move layer itself. Tests still need it because the harness HTML and the
 * API run on different origins.
 */

type Handler = (req: Request) => Promise<Response>;

export function withCors(handler: Handler, origin: string): Handler {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Last-Event-ID",
    "Access-Control-Max-Age": "86400",
  };
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
