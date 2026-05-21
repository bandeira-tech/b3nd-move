/**
 * @module
 * Small gRPC-HTTP wire helpers shared by the route files.
 *
 * Each route handles both wire encodings (JSON / binary protobuf) by
 * branching on `ctx.encoding`. These helpers hide the
 * `from{Binary,Json}` / `to{Binary,Json}` choice so the route bodies
 * read as a single decode/encode flow.
 *
 * Body decode failures throw `BadRequest`; the dispatcher renders the
 * 400 with the standard `{ "error": message }` JSON envelope.
 */

import {
  type DescMessage,
  fromBinary,
  fromJson,
  type JsonValue,
  type MessageShape,
  toBinary,
  toJson,
} from "@bufbuild/protobuf";
import { BadRequest } from "../../router/errors.ts";
import type { Encoding } from "./router.ts";

/**
 * Read a request body and parse it through `schema` in whichever
 * encoding the request used. Throws `BadRequest("Invalid request
 * body")` on parse failure — matching the legacy service's error
 * message exactly so clients see no behaviour change.
 */
export async function readRequest<S extends DescMessage>(
  req: Request,
  schema: S,
  encoding: Encoding,
): Promise<MessageShape<S>> {
  try {
    return encoding === "binary"
      ? fromBinary(schema, new Uint8Array(await req.arrayBuffer()))
      : fromJson(schema, await req.json() as JsonValue);
  } catch {
    throw new BadRequest("Invalid request body");
  }
}

/**
 * Serialise `value` through `schema` in `encoding` and wrap in a 200
 * Response with the matching `Content-Type`. JSON / binary both end up
 * as a single bytes-or-string body, so no streaming concerns here.
 */
export function okResponse<S extends DescMessage>(
  schema: S,
  value: MessageShape<S>,
  encoding: Encoding,
): Response {
  if (encoding === "binary") {
    return new Response(toBinary(schema, value), {
      status: 200,
      headers: { "Content-Type": "application/proto" },
    });
  }
  return new Response(JSON.stringify(toJson(schema, value)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
