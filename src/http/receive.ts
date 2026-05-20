/**
 * @module
 * `POST /api/v1/receive?u=<b64>` — URIs ride in the query string;
 * the body carries only the payload array. The route zips them into
 * `Output[]` (`[uri, payload]` tuples) for the rig call, so URI
 * routing/auth can decide on a request without parsing the body.
 *
 * Body shape: `unknown[]` — one payload per `u=` URI, positional.
 * Length mismatch throws `BadRequest`. Returns one `ReceiveResult`
 * per slot.
 *
 * 200 with per-slot accept/reject is a domain outcome; request-level
 * failures (bad JSON, count mismatch, malformed `?u=`) surface as
 * plain-text 400 via the dispatcher.
 */

import type { Output } from "@bandeira-tech/b3nd-core/types";
import { BadRequest } from "../router/errors.ts";
import { route } from "./router.ts";
import { decodeUriList } from "./uri-list.ts";
import { json, readJson } from "./wire.ts";

export const receiveRoute = route({
  on: { method: "POST", path: "/api/v1/receive" },
  action: "receive",
  decode: async ({ req }) => {
    const u = new URL(req.url).searchParams.get("u");
    if (!u) throw new BadRequest("Missing ?u= URI list");
    let uris: string[];
    try {
      uris = decodeUriList(u);
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : String(e));
    }
    const body = await readJson(req);
    if (!Array.isArray(body)) {
      throw new BadRequest("Expected payload array as body");
    }
    if (body.length !== uris.length) {
      throw new BadRequest(
        `Payload count (${body.length}) does not match URI count (${uris.length})`,
      );
    }
    const outputs: Output[] = uris.map((uri, i) => [uri, body[i]]);
    return [outputs];
  },
  encode: (results) => json(results, 200),
});
