/**
 * @module
 * `POST /api/v1/read?u=<b64>` — the URL list rides in the query
 * string so routing / auth / observability can see the request
 * identity without touching the body. There is no request body.
 *
 * Response body is `application/octet-stream` framed by
 * `outputs-frame` (`../codecs/outputs-frame.ts`): one slot per result,
 * each carrying `<flag><uri><payload>`. Bytes payloads round-trip
 * verbatim — no `JSON.stringify` ever touches a `Uint8Array`, so
 * `receive` (opaque bytes up) and `read` (opaque bytes down) are
 * symmetric. Non-bytes payloads are JSON-encoded per slot (flag=0)
 * as a fallback so structured payloads still survive the trip.
 *
 * The `?u=` encoding is defined in `../codecs/url-list.ts`
 * (url-safe-base64 of length-prefixed `<u16 url-len><url-utf8>`
 * records). Decode failures surface as `BadRequest` via the
 * dispatcher.
 */

import { readAction } from "../actions/standard.ts";
import { encodeOutputsFrame } from "../codecs/outputs-frame.ts";
import { decodeUrlList } from "../codecs/url-list.ts";
import { BadRequest } from "../router/errors.ts";
import { httpRequest, route } from "./router.ts";

export const readRoute = route({
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
  encode: (outs) =>
    // Cast around lib.dom's `BodyInit` not accepting `Uint8Array<ArrayBufferLike>`
    // — same dance as the receive client body in `./client.ts`.
    new Response(encodeOutputsFrame(outs) as unknown as BodyInit, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    }),
});
