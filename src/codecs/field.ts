/**
 * @module
 * Field-envelope codec — bytes-plus-metadata payload ↔ raw body with
 * a host-controlled content-type.
 *
 * The on-the-wire envelope is:
 *
 *   payload = { [name]: bytes, [contentTypeField]?: contentType, ... }
 *
 * Both halves agree on it, so a PUT through `decode` followed by a
 * GET through `encode` round-trips the bytes with no envelope drift.
 * This is the round-trip codec — pick it when the same protocol
 * stores and serves the same blob through both facets.
 *
 *   encode:
 *     - read bytes from `payload[name]`
 *     - read content-type from `payload[contentTypeField]` (if set),
 *       else fall back to `defaultContentType`
 *     - body = bytes, Content-Type = the resolved content-type
 *   decode:
 *     - bytes = `Uint8Array(req.arrayBuffer())`
 *     - if `contentTypeField`, also write the request `Content-Type`
 *       into `payload[contentTypeField]`
 *
 * @example
 * ```ts
 * import { field } from "@bandeira-tech/b3nd-move/codecs/field";
 *
 * const blob = field("bytes", { contentTypeField: "contentType" });
 * httpGetContentApi(rig,  { payloadResponseMap: blob.encode });
 * httpPostContentApi(rig, { payloadDecoder:     blob.decode });
 * ```
 */

import type { Codec } from "./codec.ts";

export interface FieldOptions {
  /**
   * Payload field that carries the wire `Content-Type`. When set,
   * `encode` reads it; `decode` writes it from the request header.
   * Omit to ignore content-type on the payload side (use
   * `defaultContentType` instead).
   */
  contentTypeField?: string;
  /**
   * Fallback content-type for `encode` when `contentTypeField` is
   * missing or its value is empty. Required if you want `encode` to
   * work for payloads that don't carry their own content-type.
   */
  defaultContentType?: string;
}

export function field(name: string, opts: FieldOptions = {}): Codec {
  const { contentTypeField, defaultContentType } = opts;

  return {
    encode: (_req, [, payload]) => {
      if (payload == null || typeof payload !== "object") {
        throw new TypeError(`field(${name}): payload must be an object`);
      }
      const obj = payload as Record<string, unknown>;
      const body = obj[name];
      if (body == null) {
        throw new TypeError(`field(${name}): missing field "${name}"`);
      }
      let contentType = defaultContentType;
      if (contentTypeField) {
        const fromPayload = obj[contentTypeField];
        if (typeof fromPayload === "string" && fromPayload.length > 0) {
          contentType = fromPayload;
        }
      }
      if (!contentType) {
        throw new TypeError(
          `field(${name}): no content-type — set defaultContentType or have payload provide "${contentTypeField}"`,
        );
      }
      return Promise.resolve({
        body: body as BodyInit,
        headers: { "Content-Type": contentType },
      });
    },

    decode: async (req) => {
      const bytes = new Uint8Array(await req.arrayBuffer());
      const out: Record<string, unknown> = { [name]: bytes };
      if (contentTypeField) {
        const ct = req.headers.get("Content-Type");
        if (ct) out[contentTypeField] = ct;
      }
      return out;
    },
  };
}
