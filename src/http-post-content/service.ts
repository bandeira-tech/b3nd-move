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
import type { ReceiveResult } from "@bandeira-tech/b3nd-core/types";
import type { Decoder } from "../codecs/codec.ts";

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

const PREFIX = "/api/v1/content/";

// ── API factory ──

/**
 * Create a POST-only HTTP handler that decodes the request body into a
 * payload and feeds `rig.receive([[uri, payload]])`.
 *
 * - `POST /api/v1/content/<encoded-uri>` → 200 with `ReceiveResult` JSON
 * - decoder throws                      → 400
 * - rig.receive throws                  → 500
 * - URI not extractable from path       → 404 / 400
 * - non-POST                            → 405
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
  const { payloadDecoder } = options;

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    const path = new URL(req.url).pathname;
    if (!path.startsWith(PREFIX) || path.length === PREFIX.length) {
      return new Response("Not Found", { status: 404 });
    }

    let uri: string;
    try {
      uri = decodeURIComponent(path.slice(PREFIX.length));
    } catch {
      return new Response("Bad Request: invalid URI encoding", { status: 400 });
    }

    let payload: unknown;
    try {
      payload = await payloadDecoder(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`payloadDecoder failed: ${msg}`, { status: 400 });
    }

    let result: ReceiveResult;
    try {
      const results = await rig.receive([[uri, payload]]);
      result = results[0];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`receive failed: ${msg}`, { status: 500 });
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}
