/**
 * @module
 * `POST /api/v1/receive` — `rig.receive(outputs)` over the operator-
 * declared `HttpBatchCodec`. The codec parses the body into
 * `Output[]`; the route forwards to `receiveAction` and replies with
 * JSON per-slot results.
 */

import { receiveAction } from "../actions/standard.ts";
import { BadRequest } from "../router/errors.ts";
import type { HttpBatchCodec } from "./codec.ts";
import { httpRequest, route } from "./router.ts";
import { json } from "./wire.ts";

export function receiveRoute(codec: HttpBatchCodec) {
  return route({
    on: httpRequest("POST", "/api/v1/receive"),
    decode: async ({ req }) => {
      let outputs;
      try {
        outputs = await codec.decode(req);
      } catch (e) {
        throw new BadRequest(e instanceof Error ? e.message : String(e));
      }
      return [outputs] as const;
    },
    action: receiveAction,
    encode: (results) => json(results, 200),
  });
}
