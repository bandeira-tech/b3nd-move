/**
 * @module
 * HTTP specialisation of the generic `Route` + the dispatcher.
 *
 * The transport-shaped bits live here:
 *
 *   HttpMatcher  `{ method, path }` with `:param` placeholders
 *   HttpContext  `{ req, params, abort }` — what decode/encode see
 *   route()      constructor that infers Args/Result from the action fn
 *   dispatchHttp walks a list of `Route` and runs the first match
 *
 * The data structure itself (`Route`, `Action`) lives in
 * `../router/route.ts` and is transport-agnostic.
 *
 * `path` patterns support `:name` placeholders captured into
 * `ctx.params`. The dispatcher emits standards-compliant
 * `405 Method Not Allowed` automatically when the path matches some
 * route but its method doesn't — `Allow:` header is the union of
 * methods from all path-matching routes.
 *
 * Routes whose `encode` returns `undefined` (e.g. fire-and-forget
 * control frames) render as `204 No Content`. HTTP always emits some
 * response; `204` is how it represents "nothing to say".
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
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

/** Declarative matcher: method + path-with-`:params`. */
export interface HttpMatcher {
  /** Single method or a list. Used both for match and the `Allow:` header. */
  method: string | readonly string[];
  /**
   * Path pattern. Exact-match by default; `:name` segments capture
   * one URL segment into `ctx.params[name]` (empty captures don't
   * match — `/foo/` doesn't match `/foo/:x`).
   */
  path: string;
}

/** Path params extracted from `:name` placeholders in the pattern. */
export type PathParams = Record<string, string>;

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
 *     on: { method: "GET", path: "/api/v1/status" },
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

// ── Matcher compilation ──

interface Compiled {
  methods: readonly string[];
  match: (path: string) => PathParams | null;
}

function methodList(m: HttpMatcher["method"]): readonly string[] {
  return typeof m === "string" ? [m] : m;
}

function compile(matcher: HttpMatcher): Compiled {
  const segments = matcher.path.split("/");
  return {
    methods: methodList(matcher.method),
    match(path: string): PathParams | null {
      const ps = path.split("/");
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
      return params;
    },
  };
}

// ── Dispatch ──

/**
 * Walk `routes` against `req`, run the first whose method + path
 * match, run the action, and return its `encode` response.
 *
 *   path doesn't match anything                 → 404
 *   path matches but no method does             → 405 with `Allow:` union
 *   `decode`/`action`/`encode` throws HttpError → status + plain-text body
 *   anything else thrown                        → 500 with that message
 *   `encode` returns undefined                  → 204 No Content
 *   full match                                  → run action → encode
 *
 * Errors are wire-adapter concerns (bad JSON, bad encoding, missing
 * resource at the route layer) and never reach the rig. Throwing
 * an `HttpError` is the way routes signal them — see `../router/errors.ts`.
 */
export async function dispatchHttp(
  rig: Rig,
  routes: readonly HttpRoute[],
  req: Request,
): Promise<Response> {
  const path = new URL(req.url).pathname;
  const allowed = new Set<string>();

  for (const r of routes) {
    const c = compile(r.on);
    const params = c.match(path);
    if (params === null) continue;
    if (!c.methods.includes(req.method)) {
      for (const m of c.methods) allowed.add(m);
      continue;
    }

    // Per-request lifecycle. For streaming actions (observe) this is
    // the signal the rig observer sees; for unary it's effectively
    // ignored but still wired so encoders can opt in.
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    req.signal.addEventListener("abort", onAbort, { once: true });
    const ctx: HttpContext = { req, params, abort };

    try {
      const args = await r.decode(ctx);
      // `await` resolves promises and is a no-op for observe's
      // AsyncIterable, leaving it for encode to stream.
      const result = await r.action(rig, args, abort.signal);
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
