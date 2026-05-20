/**
 * @module
 * JSON codec — payload ↔ `application/json` body.
 *
 *   encode: `{ body: JSON.stringify(payload), headers: { Content-Type: "application/json" } }`
 *   decode: `await req.json()`
 *
 * The natural default for protocol-shaped payloads (objects, arrays,
 * scalars). Pair both halves on a host that needs round-trip JSON:
 *
 *   import { json } from "@bandeira-tech/b3nd-move/codecs/json";
 *   const c = json();
 *   httpGetContentApi(rig,  { payloadResponseMap: c.encode });
 *   httpPostContentApi(rig, { payloadDecoder:     c.decode });
 */

import type { Codec } from "./codec.ts";

export function json(): Codec {
  return {
    encode: (_req, [, payload]) =>
      Promise.resolve({
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      }),
    decode: (req) => req.json(),
  };
}
