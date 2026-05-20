/**
 * @module
 * HTTP specialisation of the generic `Route` + the dispatcher.
 *
 * The transport-shaped bits live here:
 *
 *   HttpMatcher  `{ method, path }` with `:param` placeholders
 *   HttpContext  `{ req, params, abort }` — what decode/encode see
 *   route<A>()   constructor that preserves action narrowing
 *   dispatchHttp walks a list of `Route` and runs the first match
 *
 * The data structure itself (`Route`, `ArgsFor`, `ResultFor`) lives in
 * `./route.ts` and is transport-agnostic.
 *
 * `path` patterns support `:name` placeholders captured into
 * `ctx.params`. The dispatcher emits standards-compliant
 * `405 Method Not Allowed` automatically when the path matches some
 * route but its method doesn't — `Allow:` header is the union of
 * methods from all path-matching routes.
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import type { ActionName } from "../actions/run.ts";
import { HttpError } from "../router/errors.ts";
import type { Route } from "../router/route.ts";

/**
 * Internal alias for an HTTP-specialised `Route`. Not exported — the
 * public name is the generic `Route`. This just keeps the dispatcher
 * and `route()` signatures from spelling out the four type params at
 * every site.
 */
type HttpRoute<A extends ActionName = ActionName> = Route<
  A,
  HttpMatcher,
  HttpContext,
  Response
>;

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
 * Type-preserving HTTP route constructor. Use this so `decode`'s args
 * and `encode`'s result narrow from the literal `action`:
 *
 *   route({
 *     on: { method: "GET", path: "/api/v1/status" },
 *     action: "status",
 *     decode: () => [],               // narrowed to ArgsFor<"status">
 *     encode: (r) => json(r, …),      // r: StatusResult
 *   })
 *
 * The return is erased to `Route` so heterogeneous routes share a
 * single table type.
 */
export function route<A extends ActionName>(r: HttpRoute<A>): HttpRoute {
  return r as HttpRoute;
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
 *   path doesn't match anything           → 404
 *   path matches but no method does       → 405 with `Allow:` union
 *   `decode`/`encode` throws HttpError    → status + plain-text body
 *   `decode`/`encode` throws anything else → 500 with that message
 *   full match                            → run action → encode
 *
 * Errors are wire-adapter concerns (bad JSON, bad encoding, missing
 * resource at the route layer) and never reach the rig. Throwing
 * an `HttpError` is the way routes signal them — see `./errors.ts`.
 */
export async function dispatchHttp(
  rig: Rig,
  routes: readonly HttpRoute[],
  req: Request,
): Promise<Response> {
  const path = new URL(req.url).pathname;
  const allowed = new Set<string>();

  for (const route of routes) {
    const c = compile(route.on);
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
      const args = await route.decode(ctx);
      const result = await execute(rig, route.action, args, abort.signal);
      // The action discriminant guarantees result matches the route's
      // ResultFor<A>, but TS can't carry that across the existential
      // erasure in the heterogeneous routes array.
      return await route.encode(result as never, ctx);
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

/**
 * Dispatch the rig method for an action. Unary actions are awaited so
 * `encode` sees the unwrapped result; observe returns the live
 * AsyncIterable so encoders can stream it.
 */
async function execute(
  rig: Rig,
  action: ActionName,
  args: readonly unknown[],
  signal: AbortSignal,
): Promise<
  StatusResult | ReceiveResult[] | Output[] | AsyncIterable<readonly string[]>
> {
  switch (action) {
    case "status":
      return await rig.status();
    case "receive":
      return await rig.receive(args[0] as Output[]);
    case "read":
      return await rig.read(args[0] as string[]);
    case "observe":
      return rig.observe(args[0] as string[], signal);
  }
}
