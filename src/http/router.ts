/**
 * @module
 * HTTP specialisation of the generic `Route` + the dispatcher.
 *
 * The transport-shaped bits live here:
 *
 *   HttpMatcher  `(req) => HttpMatchResult` — a function over the raw
 *                Request; the matcher decides hit / miss / 405-fuel
 *   HttpContext  `{ req, params, abort }` — what decode/encode see
 *   httpRequest  helper that builds the common `method + path` matcher
 *   route()      constructor that infers Args/Result from the action fn
 *   dispatchHttp walks a list of `Route` and runs the first that hits
 *
 * The data structure itself (`Route`, `Action`) lives in
 * `../router/route.ts` and is transport-agnostic.
 *
 * `on` is a function over the request primitive, not a declarative
 * struct: the matcher owns parsing the URL, splitting methods, and
 * extracting `:name` captures. The dispatcher just calls it. The win
 * is composability — a route can match on any property of the Request
 * (header, host, custom path scheme) by supplying its own function,
 * without growing the struct shape the dispatcher knows about.
 *
 * Matchers participate in 405 by returning `{ allow }` on a
 * "path matched, method didn't" miss. The dispatcher accumulates the
 * union and emits the `Allow:` header. A `null` return means "no
 * match at all" — skip this route silently.
 *
 * Routes whose `encode` returns `undefined` (e.g. fire-and-forget
 * control frames) render as `204 No Content`. HTTP always emits some
 * response; `204` is how it represents "nothing to say".
 */

import type { ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core/types";
import { HttpError } from "../router/errors.ts";
import type { Route } from "../router/route.ts";

/**
 * Internal alias for an HTTP-specialised `Route`. Not exported — the
 * public name is the generic `Route`. This just keeps the dispatcher
 * and `route()` signatures from spelling out the five type params at
 * every site.
 */
type HttpRoute<
  Args extends readonly unknown[] = readonly unknown[],
  Result = unknown,
> = Route<Args, Result, HttpMatcher, HttpContext, Response>;

// ── HTTP-specific axes of `Route` ──

/** Path params extracted from `:name` placeholders in the pattern. */
export type PathParams = Record<string, string>;

/**
 * Outcome of an HTTP matcher call.
 *
 *   `null`              — no match; the dispatcher skips this route silently.
 *   `{ params }`        — full match; the dispatcher runs decode/action/encode
 *                         and merges `params` into the ctx.
 *   `{ allow }`         — path-shape match but method didn't qualify; the
 *                         dispatcher folds `allow` into the `Allow:` union
 *                         used for the 405 response.
 *
 * Custom matchers that don't care about 405 just return `{ params }`
 * or `null` and ignore the third variant.
 */
export type HttpMatchResult =
  | { params: PathParams }
  | { allow: readonly string[] }
  | null;

/**
 * Matcher function. Operates on the raw `Request` — no pre-parsing by
 * the dispatcher — and returns the outcome above.
 */
export type HttpMatcher = (req: Request) => HttpMatchResult;

/** Per-request context handed to `decode` and `encode`. */
export interface HttpContext {
  /** The original Request. */
  req: Request;
  /** Captures from `:name` placeholders in the route's path. */
  params: PathParams;
  /**
   * Per-request abort. Cancelled when the request signal fires;
   * cancel it from within a streaming encoder when the consumer
   * disconnects (see `ndjsonResponse`).
   */
  abort: AbortController;
}

/**
 * Type-preserving HTTP route constructor. Infers `Args`/`Result` from
 * the supplied `action` so `decode`'s tuple and `encode`'s input
 * narrow automatically:
 *
 *   route({
 *     on: httpRequest("GET", "/api/v1/status"),
 *     decode: () => [] as const,        // → []
 *     action: statusAction,             // → Promise<StatusResult>
 *     encode: (r) => json(r, …),        // r: StatusResult
 *   })
 *
 * The return is erased to the default `HttpRoute` so heterogeneous
 * routes share a single table type.
 */
export function route<Args extends readonly unknown[], Result>(
  r: HttpRoute<Args, Result>,
): HttpRoute {
  // Erase Args/Result to the heterogeneous-table type. The dispatcher
  // re-narrows per-route via the action's runtime closure, so the
  // erasure is safe at the call site.
  return r as unknown as HttpRoute;
}

// ── The common-case matcher ──

/**
 * Build the `method + path` matcher — what every route used to write
 * inline. `method` is a single verb or a list; `path` supports
 * `:name` placeholders captured into `ctx.params`.
 *
 *   httpRequest("GET", "/api/v1/status")
 *   httpRequest(["GET", "POST"], "/api/v1/content/:uri")
 *
 * Matching is strict: a `:param` segment requires a non-empty capture,
 * so `/foo/` doesn't match `/foo/:x`. On a path match where the method
 * doesn't qualify, the matcher returns `{ allow: methods }` so the
 * dispatcher can render a standards-compliant 405.
 */
export function httpRequest(
  method: string | readonly string[],
  path: string,
): HttpMatcher {
  const methods = typeof method === "string" ? [method] : method;
  const segments = path.split("/");
  return (req) => {
    const ps = new URL(req.url).pathname.split("/");
    if (ps.length !== segments.length) return null;
    const params: PathParams = {};
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.startsWith(":")) {
        // Strict: `:param` requires a non-empty capture so trailing
        // slashes (`/foo/`) don't accidentally match `/foo/:x`.
        if (ps[i] === "") return null;
        params[seg.slice(1)] = ps[i];
      } else if (seg !== ps[i]) {
        return null;
      }
    }
    if (!methods.includes(req.method)) return { allow: methods };
    return { params };
  };
}

// ── Dispatch ──

/**
 * Walk `routes` against `req`, call each `on(req)`, and run the first
 * route that hits.
 *
 *   every matcher returns null                  → 404
 *   only `{ allow }` results                    → 405 with the `Allow:` union
 *   `decode`/`action`/`encode` throws HttpError → status + plain-text body
 *   anything else thrown                        → 500 with that message
 *   `encode` returns undefined                  → 204 No Content
 *   first `{ params }` hit                      → run action → encode
 *
 * Errors are wire-adapter concerns (bad JSON, bad encoding, missing
 * resource at the route layer) and never reach the pin. Throwing an
 * `HttpError` is the way routes signal them — see `../router/errors.ts`.
 */
export async function dispatchHttp(
  pin: ProtocolInterfaceNode,
  routes: readonly HttpRoute[],
  req: Request,
): Promise<Response> {
  const allowed = new Set<string>();

  for (const r of routes) {
    const m = r.on(req);
    if (m === null) continue;
    if (!("params" in m)) {
      for (const verb of m.allow) allowed.add(verb);
      continue;
    }

    // Per-request lifecycle. For streaming actions (observe) this is
    // the signal the pin observer sees; for unary it's effectively
    // ignored but still wired so encoders can opt in.
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    req.signal.addEventListener("abort", onAbort, { once: true });
    const ctx: HttpContext = { req, params: m.params, abort };

    try {
      const args = await r.decode(ctx);
      // `await` resolves promises and is a no-op for observe's
      // AsyncIterable, leaving it for encode to stream.
      const result = await r.action(pin, args, abort.signal);
      const out = await r.encode(result as Awaited<typeof result>, ctx);
      return out ?? new Response(null, { status: 204 });
    } catch (e) {
      return renderError(e);
    } finally {
      req.signal.removeEventListener("abort", onAbort);
    }
  }

  if (allowed.size > 0) {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: [...allowed].join(", ") },
    });
  }
  return new Response("Not Found", { status: 404 });
}

/**
 * Plain-text error rendering. Status carries the category; body is
 * the human-readable message. No envelope — clients filter on
 * `response.ok` / `response.status` before reading the body.
 */
function renderError(e: unknown): Response {
  if (e instanceof HttpError) {
    return new Response(e.message, { status: e.status });
  }
  const msg = e instanceof Error ? e.message : String(e);
  return new Response(msg, { status: 500 });
}
