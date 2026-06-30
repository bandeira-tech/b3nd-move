/**
 * @module
 * `POST /api/v1/read?u=<b64>` — `rig.read(urls)` over the operator-
 * declared `HttpBatchCodec`. The URL list rides in `?u=` so routing /
 * auth / observability can decide without parsing the body; the
 * response shape is whatever the codec ships.
 *
 * The route owns no wire-shape knowledge; it forwards rig output to
 * the codec's `encode`. Stream materialization (or pass-through) is
 * the codec's affair.
 */

import { readAction } from "../actions/standard.ts";
import { decodeUrlList } from "../codecs/url-list.ts";
import { BadRequest } from "../router/errors.ts";
import type { HttpBatchCodec } from "./codec.ts";
import { httpRequest, route } from "./router.ts";

export function readRoute(codec: HttpBatchCodec) {
  return route({
    on: httpRequest("POST", "/api/v1/read"),
    decode: ({ req }) => {
      const u = new URL(req.url).searchParams.get("u");
      if (!u) throw new BadRequest("Missing ?u= URL list");
      try {
        return [decodeUrlList(u)] as const;
      } catch (e) {
        throw new BadRequest(e instanceof Error ? e.message : String(e));
      }
    },
    action: readAction,
    encode: (outputs, { req, abort }) =>
      codec.encode(outputs, { req, signal: abort.signal }),
  });
}
