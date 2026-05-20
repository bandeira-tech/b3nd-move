/**
 * @module
 * `GET /api/v1/content/:uri` — single-URI read facet.
 *
 * The route is a factory because it closes over the host's
 * `payloadResponseMap` hook. See `./service.ts` for the rationale.
 */

import type { ContentResponseInit, Encoder } from "../codecs/codec.ts";
import { BadRequest, NotFound } from "../router/errors.ts";
import { route } from "../router/http.ts";

/** Re-exported so both `service.ts` and `route.ts` agree on the contract. */
export type PayloadResponseMap = Encoder;

export interface GetContentRouteOptions {
  payloadResponseMap: PayloadResponseMap;
}

export function httpGetContentRoute(options: GetContentRouteOptions) {
  const { payloadResponseMap } = options;
  return route({
    on: { method: "GET", path: "/api/v1/content/:uri" },
    action: "read",
    decode: ({ params }) => {
      let uri: string;
      try {
        uri = decodeURIComponent(params.uri);
      } catch {
        throw new BadRequest("invalid URI encoding");
      }
      return [[uri]];
    },
    encode: async (results, { req }) => {
      const output = results[0];
      if (!output) throw new NotFound();

      const init: ContentResponseInit = await payloadResponseMap(req, output);
      return new Response(init.body, {
        status: init.status ?? 200,
        headers: init.headers,
      });
    },
  });
}
