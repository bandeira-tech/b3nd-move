/**
 * @module
 * `POST /api/v1/read` — body is `string[]` (urls). Returns `Output[]`
 * 1:1 with input. Content semantics (miss representation, binary
 * encoding) are the executing protocol's concern.
 */

import { validateUrls } from "../actions/validate.ts";
import { BadRequest } from "../router/errors.ts";
import { route } from "./router.ts";
import { json, readJson } from "./wire.ts";

export const readRoute = route({
  on: { method: "POST", path: "/api/v1/read" },
  action: "read",
  decode: async ({ req }) => {
    const body = await readJson(req);
    const v = validateUrls(body);
    if (!v.ok) throw new BadRequest(v.error);
    return [v.value];
  },
  encode: (outs) => json(outs, 200),
});
