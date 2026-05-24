/**
 * @module
 * `POST /b3nd.v1.B3ndService/Observe` — `rig.observe(urls)`.
 *
 * Always streams NDJSON regardless of the request encoding — the
 * connectrpc streaming envelope format is not implemented here, so
 * binary observers degrade to JSON. Frames are encoded through
 * `ObserveFrameSchema.toJson` so the line shape matches the proto
 * definition (`{ "uris": [...] }`) rather than a bare `string[]`.
 *
 * `ctx.abort` is wired to `req.signal` by the dispatcher;
 * `ndjsonResponse` fires it again on consumer cancel, propagating to
 * the rig observer.
 */

import { create, toJson } from "@bufbuild/protobuf";
import { observeAction } from "../../actions/standard.ts";
import {
  ObserveFrameSchema,
  ObserveRequestSchema,
} from "../proto/gen/b3nd_pb.ts";
import { ndjsonResponse } from "../../actions/ndjson.ts";
import { BadRequest } from "../../router/errors.ts";
import { grpcMethod, route } from "./router.ts";
import { readRequest } from "./wire.ts";

export const observeRoute = route({
  on: grpcMethod("Observe"),
  decode: async ({ req }) => {
    // Observe is JSON-only on the wire today; force the codec so
    // binary clients still get a parseable error rather than a hang.
    const body = await readRequest(req, ObserveRequestSchema, "json");
    if (!body.urls?.length) throw new BadRequest("Expected { urls: string[] }");
    return [body.urls] as const;
  },
  action: observeAction,
  encode: (frames, { abort }) =>
    ndjsonResponse(
      frames,
      abort,
      (frame) =>
        toJson(
          ObserveFrameSchema,
          create(ObserveFrameSchema, { uris: [...frame] }),
        ),
    ),
});
