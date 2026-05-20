/**
 * @module
 * `POST /api/v1/read?u=<b64>` — URIs ride in the query string so
 * routing / auth / observability can see the identity without
 * touching the body. There is no body. Response is `Output[]` 1:1
 * with the requested URIs, in order.
 *
 * The `?u=` encoding is defined in `./uri-list.ts` (url-safe-base64
 * of length-prefixed `<u16 url-len><url-utf8>` records). Decode
 * failures surface as `BadRequest` via the dispatcher.
 */

import { BadRequest } from "../router/errors.ts";
import { route } from "./router.ts";
import { decodeUriList } from "./uri-list.ts";
import { json } from "./wire.ts";

export const readRoute = route({
  on: { method: "POST", path: "/api/v1/read" },
  action: "read",
  decode: ({ req }) => {
    const u = new URL(req.url).searchParams.get("u");
    if (!u) throw new BadRequest("Missing ?u= URI list");
    try {
      return [decodeUriList(u)];
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : String(e));
    }
  },
  encode: (outs) => json(outs, 200),
});
