/**
 * @module
 * `POST /b3nd.v1.B3ndService/Receive` — `rig.receive(messages)`.
 *
 * Request body is `ReceiveRequest { messages: OutputProto[] }`,
 * decoded through `outputFromProto`. Empty `messages` is the one
 * shape-level validation kept inline here (`BadRequest`); deeper
 * checks live with the rig.
 */

import { create } from "@bufbuild/protobuf";
import type { Output } from "@bandeira-tech/b3nd-core/types";
import { receiveAction } from "../../actions/standard.ts";
import {
  ReceiveRequestSchema,
  ReceiveResponseSchema,
} from "../proto/gen/b3nd_pb.ts";
import { outputFromProto, receiveResultToProto } from "../proto/convert.ts";
import { BadRequest } from "../../router/errors.ts";
import { grpcMethod, route } from "./router.ts";
import { okResponse, readRequest } from "./wire.ts";

export const receiveRoute = route({
  on: grpcMethod("Receive"),
  decode: async ({ req, encoding }) => {
    const body = await readRequest(req, ReceiveRequestSchema, encoding);
    if (!body.messages?.length) {
      throw new BadRequest("Expected [[uri, payload], ...]");
    }
    const outputs: Output[] = body.messages.map((m) => outputFromProto(m));
    return [outputs] as const;
  },
  action: receiveAction,
  encode: (results, { encoding }) =>
    okResponse(
      ReceiveResponseSchema,
      create(ReceiveResponseSchema, {
        results: results.map(receiveResultToProto),
      }),
      encoding,
    ),
});
