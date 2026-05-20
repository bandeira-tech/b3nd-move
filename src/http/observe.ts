/**
 * @module
 * `POST /api/v1/observe` — body is `string[]` (patterns). Returns an
 * NDJSON stream: one JSON-encoded `string[]` (batch of uris that
 * fired) per line, matching what `rig.observe()` yields.
 *
 * `ctx.abort` is wired to `req.signal` by the dispatcher;
 * `ndjsonResponse` fires it again on consumer cancel, propagating to
 * the rig observer.
 */

import { ndjsonResponse } from "../actions/ndjson.ts";
import { validateUrls } from "../actions/validate.ts";
import { BadRequest } from "../router/errors.ts";
import { route } from "../router/http.ts";
import type { Route } from "../router/route.ts";
import { readJson } from "./wire.ts";

export const observeRoute: Route = route({
  on: { method: "POST", path: "/api/v1/observe" },
  action: "observe",
  decode: async ({ req }) => {
    const body = await readJson(req);
    const v = validateUrls(body);
    if (!v.ok) throw new BadRequest(v.error);
    return [v.value];
  },
  encode: (frames, ctx) =>
    ndjsonResponse(frames, ctx.abort, undefined, {
      "X-Accel-Buffering": "no",
    }),
});
