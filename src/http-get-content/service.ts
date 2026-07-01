/**
 * @module
 * Read-side HTTP content facet.
 *
 * Specialized request frontend that fronts `rig.read` for a single URI
 * with a host-controlled mapping from `(request, output)` → HTTP response
 * shape. Use this when you need the read surface to be cacheable,
 * embeddable, or otherwise reachable by clients that can't speak the
 * generic `httpApi` JSON-POST wire (a browser `<img src>`, a CDN, an
 * SDK that wants `Content-Type: image/png` instead of opaque JSON).
 *
 * Route lives in `./route.ts` as a declarative factory. This file
 * assembles it with the dispatcher.
 *
 * @example
 * ```ts
 * import { httpGetContentApi } from "@bandeira-tech/b3nd-move/http-get-content/service";
 * import { payloadResponseMap as map }
 *   from "@bandeira-tech/b3nd-move/http-get-content/payload-response-map";
 *
 * Deno.serve({ port: 3000 }, httpGetContentApi(rig, {
 *   payloadResponseMap: map.byExtension({
 *     png:  map.fromField("bytes", { contentType: "image/png" }),
 *     json: map.json(),
 *     "*":  map.json(),
 *   }),
 * }));
 * ```
 */

import type { ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core/types";
import { dispatchHttp } from "../http/router.ts";
import { httpGetContentRoute, type PayloadResponseMap } from "./route.ts";

// ── Types ──

// `ContentResponseInit` and the encoder type itself live in
// `src/codecs/codec.ts` so both facets share the contract. Re-exported
// here so existing imports from this module keep working.
export type { ContentResponseInit } from "../codecs/codec.ts";
export type { PayloadResponseMap };

export interface HttpGetContentApiOptions {
  /** Required. Maps `(req, output)` → response state. */
  payloadResponseMap: PayloadResponseMap;
}

// ── API factory ──

/**
 * Create a GET-only HTTP handler that reads a single URI from the rig
 * and hands the result to `payloadResponseMap` for response shaping.
 *
 * - `GET /api/v1/content/<encoded-uri>` → `rig.read([decoded-uri])` → hook → 200
 * - rig.read throws                    → 500
 * - hook throws                        → 500 (unless the hook throws `HttpError`)
 * - bad % encoding in `<uri>`          → 400
 * - non-GET method on the path         → 405 (`Allow: GET`)
 * - any other path                     → 404
 *
 * Miss semantics (e.g. payload `null` = 404 vs payload `null` = 200 with
 * a sentinel body) are the host's call — throw `NotFound` from your
 * `payloadResponseMap` to render 404 on a miss; or render whatever
 * response you want for `null` payloads.
 */
export function httpGetContentApi(
  rig: ProtocolInterfaceNode,
  options: HttpGetContentApiOptions,
): (req: Request) => Promise<Response> {
  const routes = [httpGetContentRoute(options)];
  return (req) => dispatchHttp(rig, routes, req);
}
