/**
 * @module
 * `{ type: "status", payload: {} }` → `{ data: StatusResult }`.
 *
 * Symmetric with `http/status.ts` minus the metadata factory — WS
 * status has no host-defined extras today, so the route is a constant.
 */

import { route } from "./router.ts";

export const statusRoute = route({
  on: { type: "status" },
  action: "status",
  decode: () => [],
  encode: (data, { id }) => ({ id, success: true, data }),
});
