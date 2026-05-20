/**
 * @module
 * Write-side HTTP content facet.
 *
 * Specialized request frontend that fronts `rig.receive` for a single
 * URI. The request body becomes the message payload via a
 * host-supplied decoder hook, and the rig's `ReceiveResult` is the
 * response.
 *
 * Mirror of `http-get-content`: same locked-route shape, one hook at
 * instantiation, helpers in a sibling file. Use this when callers
 * can't speak the generic `httpApi` JSON-POST wire — browsers
 * uploading a file, `curl --data-binary`, SDK clients that already
 * have raw bytes and don't want to wrap them in `[[uri, payload]]`.
 *
 * Route:
 *
 *   POST /api/v1/content/<url-encoded-uri>   → rig.receive([[uri, payload]])
 *
 * @example
 * ```ts
 * import { httpPostContentApi } from "@bandeira-tech/b3nd-move/http-post-content/service";
 * import { payloadDecoder as dec }
 *   from "@bandeira-tech/b3nd-move/http-post-content/payload-decoder";
 *
 * Deno.serve({ port: 3000 }, httpPostContentApi(rig, {
 *   payloadDecoder: dec.byContentType({
 *     "application/json": dec.json(),
 *     "text/plain":       dec.text(),
 *     default:            dec.intoField("bytes", { keepContentType: true }),
 *   }),
 * }));
 * ```
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import type { Decoder } from "../codecs/codec.ts";
import { dispatchHttp, type HttpRoute, route } from "../router/http.ts";

// ── Types ──

/**
 * Decodes the request body into the message payload that goes into
 * `rig.receive([[uri, payload]])`. Throws on decode failure → 400.
 *
 * Alias of {@link Decoder} from `src/codecs/codec.ts`.
 */
export type PayloadDecoder = Decoder;

export interface HttpPostContentApiOptions {
  /** Required. Maps the request body → message payload. */
  payloadDecoder: PayloadDecoder;
}

// ── Route ──

function buildRoute(options: HttpPostContentApiOptions): HttpRoute {
  const { payloadDecoder } = options;

  return route({
    on: { method: "POST", path: "/api/v1/content/:uri" },
    action: "receive",
    decode: async (req, params) => {
      let uri: string;
      try {
        uri = decodeURIComponent(params.uri);
      } catch {
        return new Response("Bad Request: invalid URI encoding", {
          status: 400,
        });
      }

      let payload: unknown;
      try {
        payload = await payloadDecoder(req);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(`payloadDecoder failed: ${msg}`, { status: 400 });
      }
      return [[[uri, payload]]];
    },
    encode: (results) => {
      const result = results[0];
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
}

// ── API factory ──

/**
 * Create a POST-only HTTP handler that decodes the request body into a
 * payload and feeds `rig.receive([[uri, payload]])`.
 *
 * - `POST /api/v1/content/<encoded-uri>` → 200 with `ReceiveResult` JSON
 * - decoder throws                      → 400
 * - rig.receive throws                  → 500
 * - bad % encoding in `<uri>`           → 400
 * - non-POST method on the path         → 405 (`Allow: POST`)
 * - any other path                      → 404
 *
 * The response body is the single `ReceiveResult` from the rig. Status
 * is 200 even when `accepted: false` — accept/reject is the rig's
 * domain outcome, not a transport failure (mirrors `/api/v1/receive`
 * on `httpApi`). Hosts that want different status semantics wrap the
 * handler at the runtime layer.
 */
export function httpPostContentApi(
  rig: Rig,
  options: HttpPostContentApiOptions,
): (req: Request) => Promise<Response> {
  const routes = [buildRoute(options)];
  return (req) => dispatchHttp(rig, routes, req);
}
