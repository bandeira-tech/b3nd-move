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
import {
  ReceiveRequestSchema,
  ReceiveResponseSchema,
} from "../proto/gen/b3nd_pb.ts";
import { outputFromProto, receiveResultToProto } from "../proto/convert.ts";
import { BadRequest } from "../../router/errors.ts";
import { route } from "./router.ts";
import { okResponse, readRequest } from "./wire.ts";

export const receiveRoute = route({
  on: { method: "Receive" },
  action: "receive",
  decode: async ({ req, encoding }) => {
    const body = await readRequest(req, ReceiveRequestSchema, encoding);
    if (!body.messages?.length) {
      throw new BadRequest("Expected [[uri, payload], ...]");
    }
    return [body.messages.map((m) => outputFromProto(m))];
  },
  encode: (results, { encoding }) =>
    okResponse(
      ReceiveResponseSchema,
      create(ReceiveResponseSchema, {
        results: results.map(receiveResultToProto),
      }),
      encoding,
    ),
});
