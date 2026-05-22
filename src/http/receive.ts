/**
 * @module
 * `POST /api/v1/receive?u=<b64>` — the URI list rides in the query
 * string; the body is `application/octet-stream` carrying opaque
 * payload bytes framed by the same `bytes-list` codec used for the
 * URI list, just at `lenSize: 4` so individual payloads can be large
 * (see `../codecs/bytes-list.ts`). Receive's strings are URIs, not
 * URLs — `receive` specifically identifies the resource each payload
 * is being written to; there's no pattern / listing / query
 * semantic at this route.
 *
 * The route slices the body into per-URI `Uint8Array` views and
 * hands `Output<Uint8Array>[]` to the rig — no payload is ever
 * decoded at this layer.
 *
 * The win vs. the prior JSON-body shape: the move layer never pays
 * the JSON.parse cost on the request body. Downstream consumers
 * (PIN clients that own the schema) decode at their own boundary.
 *
 * Length mismatch between URI count and payload count throws
 * `BadRequest`. Returns one `ReceiveResult` per slot as JSON.
 */

import type { Output } from "@bandeira-tech/b3nd-core/types";
import { receiveAction } from "../actions/standard.ts";
import { decodeBytesList } from "../codecs/bytes-list.ts";
import { decodeUrlList } from "../codecs/url-list.ts";
import { BadRequest } from "../router/errors.ts";
import { route } from "./router.ts";
import { json } from "./wire.ts";

export const receiveRoute = route({
  on: { method: "POST", path: "/api/v1/receive" },
  decode: async ({ req }) => {
    const u = new URL(req.url).searchParams.get("u");
    if (!u) throw new BadRequest("Missing ?u= URI list");
    let uris: string[];
    try {
      uris = decodeUrlList(u);
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : String(e));
    }
    const body = new Uint8Array(await req.arrayBuffer());
    let payloads: Uint8Array[];
    try {
      payloads = decodeBytesList(body, { lenSize: 4 });
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : String(e));
    }
    if (payloads.length !== uris.length) {
      throw new BadRequest(
        `Payload count (${payloads.length}) does not match URI count (${uris.length})`,
      );
    }
    const outputs: Output<Uint8Array>[] = uris.map((uri, i) => [
      uri,
      payloads[i],
    ]);
    return [outputs] as const;
  },
  action: receiveAction,
  encode: (results) => json(results, 200),
});
