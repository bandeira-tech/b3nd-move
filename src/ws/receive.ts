/**
 * @module
 * `{ type: "receive", payload: Output[] }` → `{ data: ReceiveResult[] }`.
 *
 * Payload is the canonical bare-arg shape (a non-empty `[uri, payload]`
 * array). Validation surfaces as `BadRequest`; the dispatcher renders
 * the message into the envelope's `error` field.
 */

import { receiveAction } from "../actions/standard.ts";
import { validateOutputs } from "../actions/validate.ts";
import { BadRequest } from "../router/errors.ts";
import { route, wsData } from "./router.ts";

export const receiveRoute = route({
  on: wsData("receive"),
  decode: ({ payload }) => {
    const v = validateOutputs(payload);
    if (!v.ok) throw new BadRequest(v.error);
    return [v.value] as const;
  },
  action: receiveAction,
  encode: (data, { id }) => ({ id, success: true, data }),
});
