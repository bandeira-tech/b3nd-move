/**
 * @module
 * HTTP route descriptor + dispatcher.
 *
 * A `HttpRoute` is the data structure that describes one wire-shape →
 * rig-action mapping for an HTTP transport:
 *
 *   matches(req)            cheap predicate — short-circuits dispatch
 *   build(req)              parse + validate → ActionCall (or Response on bail)
 *   respond(rig, req, call) run the action, render the response
 *
 * `respond` owns execution — the dispatcher does NOT call `runAction`
 * itself. This is deliberate so streaming actions (observe) can wire
 * the action's signal to the response stream's lifecycle (NDJSON
 * cancellation, client disconnect, …) rather than carrying a stale
 * signal baked in at build time.
 *
 * `dispatchHttp(rig, routes, req)` walks the list and runs the first
 * match. Routes that want to bail with their own error envelope
 * return a `Response` directly from `build` — different routes have
 * different 400 shapes, so error rendering lives where the route
 * knows it best.
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import type { ActionCall } from "../actions/run.ts";

/**
 * One declarative HTTP wire-shape ↔ rig-action mapping.
 *
 * Routes are walked in order. The first whose `matches` returns true
 * runs; later ones are ignored. Put more specific routes first.
 */
export interface HttpRoute {
  /**
   * Cheap predicate. Returns true if `dispatchHttp` should try to
   * build + run this route for the given request. Method + path
   * checks only — defer body parsing to `build`.
   */
  matches: (req: Request) => boolean;

  /**
   * Build the action call from the matched request. Throw → 500.
   * Return a `Response` to short-circuit the dispatcher — use this
   * for validation failures so the route owns its 400 envelope shape
   * (different routes serialize errors differently).
   */
  build: (req: Request) => Promise<ActionCall | Response>;

  /**
   * Run the action against `rig` and render the response. The route
   * is responsible for calling `runAction` (or, for streaming actions
   * like observe, deferring it to whatever wraps the response body).
   * `call` is what `build` produced.
   */
  respond: (rig: Rig, req: Request, call: ActionCall) => Promise<Response>;
}

/**
 * Walk `routes` against `req` in order, run the first match, and
 * return its response. No-match → `404`.
 *
 * The dispatcher is intentionally tiny: it doesn't catch route
 * errors (let them bubble — the host runtime decides what 500 looks
 * like), doesn't validate the table, and doesn't cache anything.
 */
export async function dispatchHttp(
  rig: Rig,
  routes: readonly HttpRoute[],
  req: Request,
): Promise<Response> {
  for (const route of routes) {
    if (!route.matches(req)) continue;

    const built = await route.build(req);
    if (built instanceof Response) return built;

    return await route.respond(rig, req, built);
  }

  return new Response("Not Found", { status: 404 });
}
