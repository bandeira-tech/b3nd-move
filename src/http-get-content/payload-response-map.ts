/**
 * @module
 * Composable building blocks for {@link PayloadResponseMap}.
 *
 * Kept separate from `service.ts` because the helper set evolves on a
 * different cadence than the route surface — we expect helpers to grow
 * (new selectors, new body shapes) while the route shape stays fixed.
 *
 * - `json()` — `JSON.stringify(payload)` + `application/json`
 * - `raw(contentType)` — payload must be `Uint8Array | ArrayBuffer | string`
 * - `fromField(name, { contentType })` — body is `payload[name]`
 * - `fixed(init)` — pin a fully-specified response (ignores output)
 * - `byExtension({ ext: map, … })` — select by URI extension; `"*"` falls back
 * - `byPayloadField(name, { value: map, … })` — select by `payload[name]`; `"*"` falls back
 *
 * Selectors compose: leaves are themselves `PayloadResponseMap`, so
 * `byExtension({ png: raw("image/png"), "*": json() })` is the natural form.
 */

import type { ContentResponseInit, PayloadResponseMap } from "./service.ts";

function json(): PayloadResponseMap {
  return (_req, [, payload]) =>
    Promise.resolve({
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    });
}

function raw(contentType: string): PayloadResponseMap {
  return (_req, [, payload]) => {
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
  };
}

function fromField(
  name: string,
  opts: { contentType: string },
): PayloadResponseMap {
  return (_req, [, payload]) => {
    if (payload == null || typeof payload !== "object") {
      throw new TypeError(`fromField(${name}): payload must be an object`);
    }
    const value = (payload as Record<string, unknown>)[name];
    if (value == null) {
      throw new TypeError(`fromField(${name}): missing field "${name}"`);
    }
    return Promise.resolve({
      body: value as BodyInit,
      headers: { "Content-Type": opts.contentType },
    });
  };
}

function fixed(init: ContentResponseInit): PayloadResponseMap {
  return () => Promise.resolve(init);
}

function extensionOf(uri: string): string {
  const lastSlash = uri.lastIndexOf("/");
  const last = uri.slice(lastSlash + 1);
  const dot = last.lastIndexOf(".");
  return dot >= 0 ? last.slice(dot + 1).toLowerCase() : "";
}

function byExtension(
  map: Record<string, PayloadResponseMap>,
): PayloadResponseMap {
  return async (req, output) => {
    const ext = extensionOf(output[0]);
    const chosen = map[ext] ?? map["*"];
    if (!chosen) {
      throw new Error(`byExtension: no mapping for ".${ext}" (and no "*")`);
    }
    return await chosen(req, output);
  };
}

function byPayloadField(
  name: string,
  map: Record<string, PayloadResponseMap>,
): PayloadResponseMap {
  return async (req, output) => {
    const [, payload] = output;
    const key = payload && typeof payload === "object"
      ? String((payload as Record<string, unknown>)[name] ?? "")
      : "";
    const chosen = map[key] ?? map["*"];
    if (!chosen) {
      throw new Error(
        `byPayloadField(${name}): no mapping for "${key}" (and no "*")`,
      );
    }
    return await chosen(req, output);
  };
}

export const payloadResponseMap = {
  json,
  raw,
  fromField,
  fixed,
  byExtension,
  byPayloadField,
};
