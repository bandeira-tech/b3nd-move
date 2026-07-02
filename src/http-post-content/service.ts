/**
 * @module
 * Write-side HTTP content facet.
 *
 * Specialized request frontend that fronts `pin.receive` for a single
 * URI. The request body becomes the message payload via a
 * host-supplied decoder hook, and the pin's `ReceiveResult` is the
 * response.
 *
 * Mirror of `http-get-content`: same locked-route shape, one hook at
 * instantiation, helpers in a sibling file. Use this when callers
 * can't speak the generic `httpApi` JSON-POST wire — browsers
 * uploading a file, `curl --data-binary`, SDK clients that already
 * have raw bytes and don't want to wrap them in `[[uri, payload]]`.
 *
 * Route lives in `./route.ts` as a declarative factory. This file
 * assembles it with the dispatcher.
 *
 * @example
 * ```ts
 * import { httpPostContentApi } from "@bandeira-tech/b3nd-move/http-post-content/service";
 * import { payloadDecoder as dec }
 *   from "@bandeira-tech/b3nd-move/http-post-content/payload-decoder";
 *
 * Deno.serve({ port: 3000 }, httpPostContentApi(pin, {
 *   payloadDecoder: dec.byContentType({
 *     "application/json": dec.json(),
 *     "text/plain":       dec.text(),
 *     default:            dec.intoField("bytes", { keepContentType: true }),
 *   }),
 * }));
 * ```
 */

import type { ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core/types";
import { dispatchHttp } from "../http/router.ts";
import { httpPostContentRoute, type PayloadDecoder } from "./route.ts";

// ── Types ──

export type { PayloadDecoder };

export interface HttpPostContentApiOptions {
  /** Required. Maps the request body → message payload. */
  payloadDecoder: PayloadDecoder;
}

// ── API factory ──

/**
 * Create a POST-only HTTP handler that decodes the request body into a
 * payload and feeds `pin.receive([[uri, payload]])`.
 *
 * - `POST /api/v1/content/<encoded-uri>` → 200 with `ReceiveResult` JSON
 * - decoder throws                      → 400
 * - pin.receive throws                  → 500
 * - bad % encoding in `<uri>`           → 400
 * - non-POST method on the path         → 405 (`Allow: POST`)
 * - any other path                      → 404
 *
 * The response body is the single `ReceiveResult` from the pin. Status
 * is 200 even when `accepted: false` — accept/reject is the pin's
 * domain outcome, not a transport failure (mirrors `/api/v1/receive`
 * on `httpApi`). Hosts that want different status semantics wrap the
 * handler at the runtime layer.
 */
export function httpPostContentApi(
  pin: ProtocolInterfaceNode,
  options: HttpPostContentApiOptions,
): (req: Request) => Promise<Response> {
  const routes = [httpPostContentRoute(options)];
  return (req) => dispatchHttp(pin, routes, req);
}
