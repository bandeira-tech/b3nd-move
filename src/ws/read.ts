/**
 * @module
 * `{ type: "read", payload: { urls: string[] } }` → `{ data: Output[] }`.
 *
 * Payload is the JSON-shaped `{ urls }` wrapper the WS client sends.
 * Validation surfaces as `BadRequest`; the dispatcher renders the
 * message into the envelope's `error` field.
 */

import { validateUrls } from "../actions/validate.ts";
import { BadRequest } from "../router/errors.ts";
import { route } from "./router.ts";

export const readRoute = route({
  on: { type: "read" },
  action: "read",
  decode: ({ payload }) => {
    const urls = (payload as { urls?: unknown } | null)?.urls;
    const v = validateUrls(urls);
    if (!v.ok) throw new BadRequest(v.error);
    return [v.value];
  },
  encode: (data, { id }) => ({ id, success: true, data }),
});
