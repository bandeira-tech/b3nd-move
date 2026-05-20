/**
 * @module
 * Codec primitives — the foundational concern of moving data on the
 * physical wire and across external standard protocols.
 *
 * A `Codec` is a symmetric pair: `encode` shapes a `rig.read` output
 * into an HTTP response init, `decode` turns an HTTP request body
 * into a `rig.receive` payload. The two halves are duals — they MUST
 * agree on the wire envelope, and sharing one declaration is the
 * cheapest way to guarantee it.
 *
 * The HTTP GET and POST content facets each consume one half:
 *
 *   import { field } from "@bandeira-tech/b3nd-move/codecs/field";
 *
 *   const blob = field("bytes", { contentTypeField: "contentType" });
 *
 *   httpGetContentApi(rig,  { payloadResponseMap: blob.encode });
 *   httpPostContentApi(rig, { payloadDecoder:     blob.decode });
 *   // PUT then GET round-trips the bytes with no chance of envelope drift.
 *
 * Codecs do NOT decide *which* wire format to use for a given request
 * — that's the per-facet selectors' job (`byExtension`, `byAccept`,
 * `byContentType`). A codec just owns the bytes-to-payload step once
 * a selector has picked it.
 */

import type { Output } from "@bandeira-tech/b3nd-core/types";

/** HTTP response state the encoder yields; the facet assembles the `Response`. */
export interface ContentResponseInit {
  body: BodyInit;
  headers?: HeadersInit;
  /** Defaults to 200. */
  status?: number;
}

/** Payload (read output) → HTTP response state. */
export type Encoder = (
  req: Request,
  output: Output,
) => Promise<ContentResponseInit>;

/** HTTP request body → payload (what `rig.receive` will see). */
export type Decoder = (req: Request) => Promise<unknown>;

/** Symmetric `(encode, decode)` pair over one wire envelope. */
export interface Codec {
  encode: Encoder;
  decode: Decoder;
}
