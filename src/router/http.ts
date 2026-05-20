/**
 * @module
 * HTTP route descriptor + dispatcher.
 *
 * A `HttpRoute` is the data structure that describes one wire-shape →
 * rig-action mapping. Three pieces:
 *
 *   on        declarative matcher — method + path pattern
 *   build     parse + validate → ActionCall (or Response on bail)
 *   respond   run the action, render the response
 *
 * `path` patterns support `:name` placeholders for path params. The
 * dispatcher extracts them and hands `build` a `params` object:
 *
 *   on: { method: "GET", path: "/api/v1/content/:uri" }
 *   build: (req, { uri }) => …
 *
 * `respond` owns execution — the dispatcher does NOT call `runAction`
 * itself. This lets streaming actions (observe) wire the action's
 * signal to the response stream's lifecycle (NDJSON cancellation,
 * client disconnect, …) rather than carrying a stale signal baked in
 * at build time.
 *
 * The dispatcher emits standards-compliant `405 Method Not Allowed`
 * automatically when the path matches some route but its method
 * doesn't — `Allow:` header is the union of methods from all
 * path-matching routes. Routes don't ship their own 405 envelopes.
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import type { ActionCall } from "../actions/run.ts";

/** Declarative matcher: method + path-with-`:params`. */
export interface HttpMatcher {
  /** Single method or a list. Used both for match and the `Allow:` header. */
  method: string | readonly string[];
  /**
   * Path pattern. Exact-match by default; `:name` segments capture
   * one URL segment into `params[name]` (empty captures don't
   * match — `/foo/` doesn't match `/foo/:x`).
   */
  path: string;
}

/** Path params extracted from `:name` placeholders in the pattern. */
export type PathParams = Record<string, string>;

/**
 * One declarative HTTP wire-shape ↔ rig-action mapping.
 *
 * Routes are walked in order. The first whose `on` matches the
 * request runs; later ones are ignored. Put more specific paths
 * before less specific ones if they could overlap.
 */
export interface HttpRoute {
  /** Declarative matcher: method + path. */
  on: HttpMatcher;
  /**
   * Build the action call. `params` carries the path-param captures.
   * Throw → 500. Return a `Response` to short-circuit — use this
   * for validation failures so each route owns its 400 envelope
   * shape. May be sync or async; the dispatcher awaits either way.
   */
  build: (
    req: Request,
    params: PathParams,
  ) => ActionCall | Response | Promise<ActionCall | Response>;
  /**
   * Run the action against `rig` and render the response. `call` is
   * what `build` produced. Streaming actions are this route's
   * responsibility: respond decides how to drain the iterable. May
   * be sync or async.
   */
  respond: (
    rig: Rig,
    req: Request,
    call: ActionCall,
  ) => Response | Promise<Response>;
}

// ── Compilation ──

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
 * match, and return its response.
 *
 *   path doesn't match anything           → 404
 *   path matches but no method does       → 405 with `Allow:` union
 *   full match                            → build → respond
 *   build returns Response                → short-circuits
 *
 * Routes are recompiled on every call — for typical tables (<10
 * routes) the cost is negligible; factor `compile` out into the
 * factory if a hot path needs it.
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
    const built = await route.build(req, params);
    if (built instanceof Response) return built;
    return await route.respond(rig, req, built);
  }

  if (allowed.size > 0) {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: [...allowed].join(", ") },
    });
  }
  return new Response("Not Found", { status: 404 });
}
