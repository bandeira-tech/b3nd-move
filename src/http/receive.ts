/**
 * @module
 * `POST /api/v1/receive` — body is `Output[]` (bare-arg shape that
 * matches `rig.receive`). Returns one `ReceiveResult` per slot.
 *
 * 200 with per-slot accept/reject is a domain outcome; request-level
 * failures (bad JSON, schema mismatch) throw `BadRequest` and surface
 * as plain-text 400 via the dispatcher.
 */

import { validateOutputs } from "../actions/validate.ts";
import { BadRequest } from "../router/errors.ts";
import { route } from "../router/http.ts";
import type { Route } from "../router/route.ts";
import { json, readJson } from "./wire.ts";

export const receiveRoute: Route = route({
  on: { method: "POST", path: "/api/v1/receive" },
  action: "receive",
  decode: async ({ req }) => {
    const body = await readJson(req);
    const v = validateOutputs(body);
    if (!v.ok) throw new BadRequest(v.error);
    return [v.value];
  },
  encode: (results) => json(results, 200),
});
