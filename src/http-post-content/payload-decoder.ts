/**
 * @module
 * Composable building blocks for {@link PayloadDecoder}.
 *
 * Kept separate from `service.ts` because the helper set evolves on a
 * different cadence than the route surface — we expect helpers to grow
 * (new body shapes, new selectors) while the route stays fixed.
 *
 * Primitives (`json`, `text`, `raw`, `intoField`) are the `decode`
 * halves of codecs in `src/codecs/`. Use the codecs directly when you
 * need round-trip guarantees with `http-get-content`.
 *
 * Selectors (`byContentType`) are facet-local — they pick which leaf
 * runs for a given request and have no encode-side dual (response
 * negotiation is the GET facet's domain).
 */

import type { PayloadDecoder } from "./service.ts";
import { json as jsonCodec } from "../codecs/json.ts";
import { text as textCodec } from "../codecs/text.ts";
import { raw as rawCodec } from "../codecs/raw.ts";
import { field as fieldCodec } from "../codecs/field.ts";

/** `await req.json()`. */
function json(): PayloadDecoder {
  return jsonCodec().decode;
}

/** `await req.text()` — payload is a string. */
function text(): PayloadDecoder {
  return textCodec().decode;
}

/** Body bytes → `Uint8Array` payload. */
function raw(): PayloadDecoder {
  // raw() codec needs a content-type for its encode half; decode
  // doesn't use it, so any placeholder works.
  return rawCodec("*").decode;
}

/**
 * Wrap raw body bytes into `{ [name]: bytes, [contentTypeField]?: ct }`.
 *
 * `keepContentType: true` is a shortcut for `contentTypeField:
 * "contentType"`. Use `contentTypeField` directly to pick a different
 * field name (or to align with a codec on the GET side).
 */
function intoField(
  name: string,
  opts: { keepContentType?: boolean; contentTypeField?: string } = {},
): PayloadDecoder {
  const contentTypeField = opts.contentTypeField ??
    (opts.keepContentType ? "contentType" : undefined);
  return fieldCodec(name, { contentTypeField }).decode;
}

function matchType(actual: string, pattern: string): boolean {
  if (pattern === "*" || pattern === "*/*") return true;
  // Strip any parameters (";charset=utf-8" etc.) before comparing.
  const a = actual.split(";")[0].trim().toLowerCase();
  const p = pattern.split(";")[0].trim().toLowerCase();
  if (p === a) return true;
  // `type/*` wildcard.
  const [pType, pSub] = p.split("/");
  const [aType, aSub] = a.split("/");
  return pType === aType && (pSub === "*" || pSub === aSub);
}

function byContentType(
  map: Record<string, PayloadDecoder> & { default?: PayloadDecoder },
): PayloadDecoder {
  return (req) => {
    const ct = req.headers.get("Content-Type") ?? "";
    for (const [pattern, leaf] of Object.entries(map)) {
      if (pattern === "default") continue;
      if (matchType(ct, pattern)) return leaf(req);
    }
    if (map.default) return map.default(req);
    throw new Error(
      `byContentType: no mapping for "${ct}" (and no "default")`,
    );
  };
}

export const payloadDecoder = {
  json,
  text,
  raw,
  intoField,
  byContentType,
};
