/**
 * @module
 * Operator-declared CORS for the HTTP-shaped transports.
 *
 * Not sugar and not auto-wired: every service factory leaves `cors`
 * off by default. An operator opts in explicitly at their construction
 * site — `httpApi(rig, { codec, cors: true })` — exactly the way they
 * declare a codec. CORS is operational policy, declared where the
 * operator wires the transport; the move layer never coerces it on.
 *
 * `cors: true` emits permissive `*` headers and answers an `OPTIONS`
 * preflight with `204`. Anything narrower — specific origins,
 * credentials, bespoke header allow-lists — is the operator's own
 * middleware in front of the handler, not this knob.
 */

type Handler = (req: Request) => Promise<Response>;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Last-Event-ID",
  "Access-Control-Max-Age": "86400",
};

/**
 * Wrap a request handler so cross-origin browsers can call it.
 *
 * - `OPTIONS` requests get a `204` preflight carrying the CORS headers.
 * - Every other response passes through with the CORS headers merged in.
 */
export function withCors(handler: Handler): Handler {
  return async (req) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const res = await handler(req);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}
