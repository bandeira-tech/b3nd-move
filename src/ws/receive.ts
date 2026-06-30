/**
 * @module
 * `{ type: "receive", payload: Output[] }` → `{ data: ReceiveResult[] }`.
 *
 * Payload shape and response encoding are delegated to the `WsBatchCodec`
 * supplied by the operator. `receiveRoute(codec)` returns a `WsRoute` bound
 * to that codec; the service wires it in via `wsApi(rig, { codec })`.
 */

import { receiveAction } from "../actions/standard.ts";
import { BadRequest } from "../router/errors.ts";
import type { WsBatchCodec } from "./codec.ts";
import { route, wsData, type WsRoute } from "./router.ts";

export function receiveRoute(codec: WsBatchCodec): WsRoute {
  return route({
    on: wsData("receive"),
    decode: ({ payload }) => {
      let outputs;
      try {
        outputs = codec.decodeReceive(payload);
      } catch (e) {
        throw new BadRequest(e instanceof Error ? e.message : String(e));
      }
      return [outputs] as const;
    },
    action: receiveAction,
    encode: async (results, { id, abort }) => {
      const data = await codec.encodeReceive(results, {
        id,
        signal: abort.signal,
      });
      return { id, success: true, data };
    },
  });
}
