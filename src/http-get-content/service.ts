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
 * Route:
 *
 *   GET /api/v1/content/<url-encoded-uri>   → rig.read([uri])  (single)
 *
 * The whole content-type / body-bytes / extra-headers decision lives in
 * one hook — `payloadResponseMap(req, output) => ContentResponseInit` —
 * supplied at instantiation. Common policies ship as composable helpers
 * in `payload-response-map.ts`: `json`, `raw`, `fromField`, `fixed`,
 * `byExtension`, `byPayloadField`.
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

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import type { Output } from "@bandeira-tech/b3nd-core/types";
import type { ContentResponseInit, Encoder } from "../codecs/codec.ts";
import { runAction } from "../actions/run.ts";

// ── Types ──

// `ContentResponseInit` and the encoder type itself live in
// `src/codecs/codec.ts` so both facets share the contract. Re-exported
// here so existing imports from this module keep working.
export type { ContentResponseInit } from "../codecs/codec.ts";

/**
 * Decides how a successful `rig.read` output becomes an HTTP response.
 * Owns content-type, body bytes, and any extra headers in one place.
 *
 * Alias of {@link Encoder} from `src/codecs/codec.ts`.
 */
export type PayloadResponseMap = Encoder;

export interface HttpGetContentApiOptions {
  /** Required. Maps `(req, output)` → response state. */
  payloadResponseMap: PayloadResponseMap;
}

const PREFIX = "/api/v1/content/";

// ── API factory ──

/**
 * Create a GET-only HTTP handler that reads a single URI from the rig
 * and hands the result to `payloadResponseMap` for response shaping.
 *
 * - `GET /api/v1/content/<encoded-uri>` → `rig.read([decoded-uri])` → hook → 200
 * - rig.read throws                    → 500
 * - hook throws                        → 500
 * - missing / malformed path           → 404 / 400
 * - non-GET                            → 405
 *
 * Miss semantics (e.g. payload `null` = 404 vs payload `null` = 200 with
 * a sentinel body) are the host's call — handle them inside your
 * `payloadResponseMap`. The facet never second-guesses payload contents.
 */
export function httpGetContentApi(
  rig: Rig,
  options: HttpGetContentApiOptions,
): (req: Request) => Promise<Response> {
  const { payloadResponseMap } = options;

  return async (req: Request): Promise<Response> => {
    if (req.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET" },
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

    let output: Output;
    try {
      const results = await runAction(rig, { action: "read", urls: [uri] });
      output = results[0];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`read failed: ${msg}`, { status: 500 });
    }
    if (!output) return new Response("Not Found", { status: 404 });

    let init: ContentResponseInit;
    try {
      init = await payloadResponseMap(req, output);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`payloadResponseMap failed: ${msg}`, { status: 500 });
    }

    return new Response(init.body, {
      status: init.status ?? 200,
      headers: init.headers,
    });
  };
}
