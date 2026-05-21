/**
 * @module
 * `{ type: "receive", payload: Output[] }` → `{ data: ReceiveResult[] }`.
 *
 * Payload is the canonical bare-arg shape (a non-empty `[uri, payload]`
 * array). Validation surfaces as `BadRequest`; the dispatcher renders
 * the message into the envelope's `error` field.
 */

import { validateOutputs } from "../actions/validate.ts";
import { BadRequest } from "../router/errors.ts";
import { route } from "./router.ts";

export const receiveRoute = route({
  on: { type: "receive" },
  action: "receive",
  decode: ({ payload }) => {
    const v = validateOutputs(payload);
    if (!v.ok) throw new BadRequest(v.error);
    return [v.value];
  },
  encode: (data, { id }) => ({ id, success: true, data }),
});
