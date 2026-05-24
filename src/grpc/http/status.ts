/**
 * @module
 * `POST /b3nd.v1.B3ndService/Status` → `rig.status()`.
 *
 * The proto schema already carries the host-defined extras (schema /
 * fns / details JSON strings), so unlike the HTTP route there's no
 * metadata factory — `statusResultToResponse` does the merge.
 */

import { statusAction } from "../../actions/standard.ts";
import { StatusResponseSchema } from "../proto/gen/b3nd_pb.ts";
import { statusResultToResponse } from "../proto/convert.ts";
import { grpcMethod, route } from "./router.ts";
import { okResponse } from "./wire.ts";

export const statusRoute = route({
  on: grpcMethod("Status"),
  decode: () => [] as const,
  action: statusAction,
  encode: (result, { encoding }) =>
    okResponse(StatusResponseSchema, statusResultToResponse(result), encoding),
});
