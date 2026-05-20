/**
 * @module
 * Raw bytes codec — `Uint8Array` payload ↔ raw body with a fixed
 * content-type.
 *
 *   encode: payload (must be `Uint8Array | ArrayBuffer | string`) →
 *           body, `Content-Type: <ct>`
 *   decode: body → `Uint8Array`
 *
 * The content-type is fixed at construction. To dispatch on incoming
 * `Content-Type` and pick a raw codec per type, wrap with the POST
 * facet's `byContentType` selector; for the GET side, wrap with
 * `byExtension` or `byAccept`.
 *
 * If you need the content-type carried *in* the payload alongside the
 * bytes (so the same payload round-trips between GET and POST without
 * a registry of extensions / accept rules), use the `field` codec
 * instead.
 */

import type { Codec } from "./codec.ts";

export function raw(contentType: string): Codec {
  return {
    encode: (_req, [, payload]) => {
      if (
        !(payload instanceof Uint8Array) &&
        !(payload instanceof ArrayBuffer) &&
        typeof payload !== "string"
      ) {
        throw new TypeError(
          `raw(${contentType}): payload must be Uint8Array, ArrayBuffer, or string`,
        );
      }
      return Promise.resolve({
        body: payload as BodyInit,
        headers: { "Content-Type": contentType },
      });
    },
    decode: async (req) => new Uint8Array(await req.arrayBuffer()),
  };
}
