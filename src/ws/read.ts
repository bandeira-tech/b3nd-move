/**
 * @module
 * `{ type: "read", payload: { urls: string[] } }` → `{ data: Output[] }`.
 *
 * Payload shape and response encoding are delegated to the `WsBatchCodec`
 * supplied by the operator. `readRoute(codec)` returns a `WsRoute` bound
 * to that codec; the service wires it in via `wsApi(rig, { codec })`.
 */

import type { Output } from "@bandeira-tech/b3nd-core/types";
import { readAction } from "../actions/standard.ts";
import { BadRequest } from "../router/errors.ts";
import type { WsBatchCodec } from "./codec.ts";
import { route, wsData, type WsRoute } from "./router.ts";

export function readRoute(codec: WsBatchCodec): WsRoute {
  return route({
    on: wsData("read"),
    decode: ({ payload }) => {
      let urls: string[];
      try {
        urls = codec.decodeRead(payload);
      } catch (e) {
        throw new BadRequest(e instanceof Error ? e.message : String(e));
      }
      return [urls] as const;
    },
    action: readAction,
    encode: async (outputs, { id, abort }) => {
      const data = await codec.encodeRead(outputs as Output[], {
        id,
        signal: abort.signal,
      });
      return { id, success: true, data };
    },
  });
}
