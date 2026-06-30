/**
 * Tiny CORS wrapper for the browser-driven integration tests.
 *
 * The service factories carry their own operator-declared `cors: boolean`
 * knob (see `src/cors.ts`), so the standard `httpApi` / `grpcHttpApi`
 * harnesses just flip that. This wrapper survives only for the bespoke
 * content harnesses (`http-get-content`, `http-post-content`) that wrap
 * hand-rolled handlers instead of a service factory and still need
 * cross-origin responses for the browser.
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
