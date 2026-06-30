/**
 * @module
 * `POST /b3nd.v1.B3ndService/Receive` — `rig.receive(messages)`.
 *
 * Request body is `ReceiveRequest { messages: OutputProto[] }`,
 * decoded through the codec's `decodeReceive`. Empty `messages` is the
 * one shape-level validation kept inline here (`BadRequest`); deeper
 * checks live with the rig.
 */

import { receiveAction } from "../../actions/standard.ts";
import {
  ReceiveRequestSchema,
  ReceiveResponseSchema,
} from "../proto/gen/b3nd_pb.ts";
import { BadRequest } from "../../router/errors.ts";
import type { GrpcBatchCodec } from "./codec.ts";
import { grpcMethod, type GrpcRoute, route } from "./router.ts";
import { okResponse, readRequest } from "./wire.ts";

export function receiveRoute(codec: GrpcBatchCodec): GrpcRoute {
  return route({
    on: grpcMethod("Receive"),
    decode: async ({ req, encoding }) => {
      const body = await readRequest(req, ReceiveRequestSchema, encoding);
      if (!body.messages?.length) {
        throw new BadRequest("Expected [[uri, payload], ...]");
      }
      const outputs = codec.decodeReceive(body);
      return [outputs] as const;
    },
    action: receiveAction,
    encode: async (results, { encoding, abort }) => {
      const protoMsg = await codec.encodeReceive(results, {
        signal: abort.signal,
      });
      return okResponse(ReceiveResponseSchema, protoMsg, encoding);
    },
  });
}
