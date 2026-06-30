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
 *   GET  /api/v1/status            → ./status.ts   (rig.status())
 *   POST /api/v1/receive?u=<b64>   → ./receive.ts  (rig.receive(outputs))
 *   POST /api/v1/read?u=<b64>      → ./read.ts     (rig.read(urls))
 *   POST /api/v1/observe?u=<b64>   → ./observe.ts  (rig.observe(urls), NDJSON)
 *
 * Each batch route packs its string list into the `?u=<urlsafe-b64>`
 * query slot (see ../codecs/url-list.ts) so routing / auth /
 * observability can decide on a request without parsing the body.
 * The strings differ in semantic: `receive` sends URIs (specific
 * resource identifiers — one per payload, no higher-order content);
 * `read` and `observe` send URLs (locators that can carry patterns,
 * listings, or queries). The codec is the same; the meaning isn't.
 *
 * The body is only used by `receive`, where it carries opaque
 * payload bytes framed by the same `bytes-list` codec at
 * `lenSize: 4` (see ../codecs/bytes-list.ts) — the move layer never
 * JSON-parses payloads; downstream consumers decode at their own
 * boundary.
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
 * import { httpOutputsFrame } from "@bandeira-tech/b3nd-move/codecs/http/mod";
 *
 * const c = connection(client, ["**"]);
 * const rig = new Rig({ routes: { receive: [c], read: [c], observe: [c] } });
 * const codec = httpOutputsFrame();
 * Deno.serve({ port: 3000 }, httpApi(rig, { codec }));
 * ```
 *
 * @example Cross-origin browser callers
 * ```ts
 * import { withCors } from "@bandeira-tech/b3nd-move/cors";
 * // CORS is upstream of the API — compose it around the handler.
 * Deno.serve(
 *   { port: 3000 },
 *   withCors(httpApi(rig, { codec }), { origin: "https://app.example.com" }),
 * );
 * ```
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import type { HttpBatchCodec } from "./codec.ts";
import { dispatchHttp } from "./router.ts";
import { observeRoute } from "./observe.ts";
import { readRoute } from "./read.ts";
import { receiveRoute } from "./receive.ts";
import { statusRoute, type StatusRouteOptions } from "./status.ts";

// ── Types ──

/**
 * `HttpApiOptions` requires an operator-declared codec (see `codec.ts`)
 * and accepts per-route options for every route that takes one
 * (currently just `status`). New per-route options get added here as
 * routes grow.
 */
export interface HttpApiOptions extends Partial<StatusRouteOptions> {
  /** Operator-declared codec for read responses + receive bodies. Required. */
  codec: HttpBatchCodec;
}

// ── API factory ──

/**
 * Create an HTTP request handler backed by a Rig.
 *
 * Returns a standard `(Request) => Promise<Response>` — plug it
 * into Deno.serve, Hono, or any other HTTP framework.
 *
 * `options.codec` is required: pass `httpOutputsFrame()` for today's
 * baked outputs-frame behaviour or supply a custom `HttpBatchCodec`.
 */
export function httpApi(
  rig: Rig,
  options: HttpApiOptions,
): (req: Request) => Promise<Response> {
  const routes = [
    statusRoute(options),
    receiveRoute(options.codec),
    readRoute(options.codec),
    observeRoute,
  ];
  return (req) => dispatchHttp(rig, routes, req);
}
