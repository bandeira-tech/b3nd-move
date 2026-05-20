/**
 * @module
 * `POST /api/v1/observe?u=<b64>` — URI patterns ride in the query
 * string (see `./uri-list.ts`). No request body. Response is an
 * NDJSON stream: one JSON-encoded `string[]` (batch of uris that
 * fired) per line, matching what `rig.observe()` yields.
 *
 * `ctx.abort` is wired to `req.signal` by the dispatcher;
 * `ndjsonResponse` fires it again on consumer cancel, propagating to
 * the rig observer.
 */

import { ndjsonResponse } from "../actions/ndjson.ts";
import { BadRequest } from "../router/errors.ts";
import { route } from "./router.ts";
import { decodeUriList } from "./uri-list.ts";

export const observeRoute = route({
  on: { method: "POST", path: "/api/v1/observe" },
  action: "observe",
  decode: ({ req }) => {
    const u = new URL(req.url).searchParams.get("u");
    if (!u) throw new BadRequest("Missing ?u= URI list");
    try {
      return [decodeUriList(u)];
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : String(e));
    }
  },
  encode: (frames, ctx) =>
    ndjsonResponse(frames, ctx.abort, undefined, {
      "X-Accel-Buffering": "no",
    }),
});
