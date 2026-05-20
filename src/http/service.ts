/**
 * @module
 * HTTP API for the Rig.
 *
 * Standalone function that translates HTTP requests to rig method calls.
 * No framework dependency, no middleware — just a `(Request) => Promise<Response>`.
 *
 * The rig stays pure (orchestration only). Transport is external.
 *
 * Each route is its own declaration in a sibling file:
 *
 *   GET  /api/v1/status     → ./status.ts   (rig.status())
 *   POST /api/v1/receive    → ./receive.ts  (rig.receive(msgs))
 *   POST /api/v1/read       → ./read.ts     (rig.read(urls))
 *   POST /api/v1/observe    → ./observe.ts  (rig.observe(urls), NDJSON)
 *
 * This file's only job is to assemble the table and hand it to the
 * shared dispatcher. Wire-adapter failures (bad JSON, schema mismatch)
 * throw `BadRequest` from within the routes; the dispatcher renders
 * them as plain-text 400. See `src/router/errors.ts`.
 *
 * @example
 * ```ts
 * import { Rig, connection } from "@bandeira-tech/b3nd-core";
 * import { httpApi } from "@bandeira-tech/b3nd-move/http/service";
 *
 * const c = connection(client, ["*"]);
 * const rig = new Rig({ routes: { receive: [c], read: [c], observe: [c] } });
 * Deno.serve({ port: 3000 }, httpApi(rig));
 * ```
 *
 * @example Hono (CORS, middleware, etc.)
 * ```ts
 * const api = httpApi(rig, { statusMeta: { version: "1.0" } });
 * const app = new Hono();
 * app.use("*", cors({ origin: "*" }));
 * app.all("/api/*", (c) => api(c.req.raw));
 * ```
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import { dispatchHttp } from "./router.ts";
import { observeRoute } from "./observe.ts";
import { readRoute } from "./read.ts";
import { receiveRoute } from "./receive.ts";
import { statusRoute, type StatusRouteOptions } from "./status.ts";

// ── Types ──

/**
 * `HttpApiOptions` is a superset of the per-route options of every
 * route that takes one (currently just `status`). New per-route
 * options get added here as routes grow.
 */
export interface HttpApiOptions extends StatusRouteOptions {}

// ── API factory ──

/**
 * Create an HTTP request handler backed by a Rig.
 *
 * Returns a standard `(Request) => Promise<Response>` — plug it
 * into Deno.serve, Hono, or any other HTTP framework.
 */
export function httpApi(
  rig: Rig,
  options?: HttpApiOptions,
): (req: Request) => Promise<Response> {
  const routes = [
    statusRoute(options),
    receiveRoute,
    readRoute,
    observeRoute,
  ];
  return (req) => dispatchHttp(rig, routes, req);
}
