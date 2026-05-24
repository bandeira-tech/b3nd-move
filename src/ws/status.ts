/**
 * @module
 * `{ type: "status", payload: {} }` → `{ data: StatusResult }`.
 *
 * Symmetric with `http/status.ts` minus the metadata factory — WS
 * status has no host-defined extras today, so the route is a constant.
 */

import { statusAction } from "../actions/standard.ts";
import { route, wsData } from "./router.ts";

export const statusRoute = route({
  on: wsData("status"),
  decode: () => [] as const,
  action: statusAction,
  encode: (data, { id }) => ({ id, success: true, data }),
});
