/**
 * @module
 * `POST /b3nd.v1.B3ndService/Read` — `rig.read(urls)`.
 *
 * Request body is `ReadRequest { urls: string[] }`. Empty `urls` is
 * the one shape-level validation kept inline here (`BadRequest`);
 * deeper checks live with the rig.
 */

import { create } from "@bufbuild/protobuf";
import { readAction } from "../../actions/standard.ts";
import { ReadRequestSchema, ReadResponseSchema } from "../proto/gen/b3nd_pb.ts";
import { outputToProto } from "../proto/convert.ts";
import { BadRequest } from "../../router/errors.ts";
import { grpcMethod, route } from "./router.ts";
import { okResponse, readRequest } from "./wire.ts";

export const readRoute = route({
  on: grpcMethod("Read"),
  decode: async ({ req, encoding }) => {
    const body = await readRequest(req, ReadRequestSchema, encoding);
    if (!body.urls?.length) throw new BadRequest("Expected { urls: string[] }");
    return [body.urls] as const;
  },
  action: readAction,
  encode: (results, { encoding }) =>
    okResponse(
      ReadResponseSchema,
      create(ReadResponseSchema, { results: results.map(outputToProto) }),
      encoding,
    ),
});
