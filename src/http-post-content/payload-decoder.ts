/**
 * @module
 * Composable building blocks for {@link PayloadDecoder}.
 *
 * Kept separate from `service.ts` because the helper set evolves on a
 * different cadence than the route surface — we expect helpers to grow
 * (new body shapes, new selectors) while the route stays fixed.
 *
 * - `json()` — `await req.json()`
 * - `text()` — `await req.text()`
 * - `raw()` — `new Uint8Array(await req.arrayBuffer())`
 * - `intoField(name, { keepContentType })` — wrap raw bytes into
 *   `{ [name]: bytes, contentType? }`
 * - `byContentType({ "type/sub": leaf, …, default: leaf })` — select by
 *   request `Content-Type`; leaves are themselves `PayloadDecoder`
 *
 * Selectors compose: leaves are decoders, so
 * `byContentType({ "application/json": json(), default: raw() })` is
 * the natural form.
 */

import type { PayloadDecoder } from "./service.ts";

function json(): PayloadDecoder {
  return (req) => req.json();
}

function text(): PayloadDecoder {
  return (req) => req.text();
}

function raw(): PayloadDecoder {
  return async (req) => new Uint8Array(await req.arrayBuffer());
}

function intoField(
  name: string,
  opts: { keepContentType?: boolean } = {},
): PayloadDecoder {
  const { keepContentType = false } = opts;
  return async (req) => {
    const bytes = new Uint8Array(await req.arrayBuffer());
    const obj: Record<string, unknown> = { [name]: bytes };
    if (keepContentType) {
      const ct = req.headers.get("Content-Type");
      if (ct) obj.contentType = ct;
    }
    return obj;
  };
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
