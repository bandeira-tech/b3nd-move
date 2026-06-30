/**
 * @module
 * `POST /b3nd.v1.B3ndService/Read` — `rig.read(urls)`.
 *
 * Request body is `ReadRequest { urls: string[] }`. Empty `urls` is
 * the one shape-level validation kept inline here (`BadRequest`);
 * deeper checks live with the rig.
 */

import { readAction } from "../../actions/standard.ts";
import { ReadRequestSchema, ReadResponseSchema } from "../proto/gen/b3nd_pb.ts";
import { BadRequest } from "../../router/errors.ts";
import type { GrpcBatchCodec } from "./codec.ts";
import { grpcMethod, route, type GrpcRoute } from "./router.ts";
import { okResponse, readRequest } from "./wire.ts";

export function readRoute(codec: GrpcBatchCodec): GrpcRoute {
  return route({
    on: grpcMethod("Read"),
    decode: async ({ req, encoding }) => {
      const body = await readRequest(req, ReadRequestSchema, encoding);
      const urls = codec.decodeRead(body);
      if (urls.length === 0) throw new BadRequest("Expected { urls: string[] }");
      return [urls] as const;
    },
    action: readAction,
    encode: async (results, { encoding, abort }) => {
      const protoMsg = await codec.encodeRead(results, { signal: abort.signal });
      return okResponse(ReadResponseSchema, protoMsg, encoding);
    },
  });
}
