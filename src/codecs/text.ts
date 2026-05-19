/**
 * @module
 * Text codec — string payload ↔ text body with a fixed content-type.
 *
 *   encode: payload (must be `string`) → body, `Content-Type: <ct>`
 *   decode: `await req.text()` (string payload)
 *
 * Defaults the content-type to `text/plain`. Override for narrower
 * MIME types like `text/markdown`, `text/csv`, etc. Decode never
 * inspects content-type — that's the selector's job upstream.
 */

import type { Codec } from "./codec.ts";

export function text(contentType: string = "text/plain"): Codec {
  return {
    encode: (_req, [, payload]) => {
      if (typeof payload !== "string") {
        throw new TypeError(`text(${contentType}): payload must be a string`);
      }
      return Promise.resolve({
        body: payload,
        headers: { "Content-Type": contentType },
      });
    },
    decode: (req) => req.text(),
  };
}
