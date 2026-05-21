/**
 * @module
 * `POST /api/v1/read?u=<b64>` — the URL list rides in the query
 * string so routing / auth / observability can see the request
 * identity without touching the body. There is no body. Response is
 * `Output[]` 1:1 with the requested URLs, in order.
 *
 * The `?u=` encoding is defined in `../codecs/url-list.ts`
 * (url-safe-base64 of length-prefixed `<u16 url-len><url-utf8>`
 * records). Decode failures surface as `BadRequest` via the
 * dispatcher.
 */

import { decodeUrlList } from "../codecs/url-list.ts";
import { BadRequest } from "../router/errors.ts";
import { route } from "./router.ts";
import { json } from "./wire.ts";

export const readRoute = route({
  on: { method: "POST", path: "/api/v1/read" },
  action: "read",
  decode: ({ req }) => {
    const u = new URL(req.url).searchParams.get("u");
    if (!u) throw new BadRequest("Missing ?u= URL list");
    try {
      return [decodeUrlList(u)];
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : String(e));
    }
  },
  encode: (outs) => json(outs, 200),
});
