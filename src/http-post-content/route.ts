/**
 * @module
 * `POST /api/v1/content/:uri` — single-URI write facet.
 *
 * The route is a factory because it closes over the host's
 * `payloadDecoder` hook. See `./service.ts` for the rationale.
 */

import type { Output } from "@bandeira-tech/b3nd-core/types";
import { receiveAction } from "../actions/standard.ts";
import type { Decoder } from "../codecs/codec.ts";
import { BadRequest } from "../router/errors.ts";
import { httpRequest, route } from "../http/router.ts";

/** Re-exported so both `service.ts` and `route.ts` agree on the contract. */
export type PayloadDecoder = Decoder;

export interface PostContentRouteOptions {
  payloadDecoder: PayloadDecoder;
}

export function httpPostContentRoute(options: PostContentRouteOptions) {
  const { payloadDecoder } = options;
  return route({
    on: httpRequest("POST", "/api/v1/content/:uri"),
    decode: async ({ req, params }) => {
      let uri: string;
      try {
        uri = decodeURIComponent(params.uri);
      } catch {
        throw new BadRequest("invalid URI encoding");
      }

      let payload: unknown;
      try {
        payload = await payloadDecoder(req);
      } catch (err) {
        throw new BadRequest(
          err instanceof Error ? err.message : String(err),
        );
      }
      const outputs: Output[] = [[uri, payload]];
      return [outputs] as const;
    },
    action: receiveAction,
    encode: (results) => {
      const result = results[0];
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
}
