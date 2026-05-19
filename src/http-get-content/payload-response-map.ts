/**
 * @module
 * Composable building blocks for {@link PayloadResponseMap}.
 *
 * Kept separate from `service.ts` because the helper set evolves on a
 * different cadence than the route surface — we expect helpers to grow
 * (new selectors, new body shapes) while the route shape stays fixed.
 *
 * Primitives (`json`, `text`, `raw`, `fromField`) are the `encode`
 * halves of codecs in `src/codecs/`. Use the codecs directly when you
 * need round-trip guarantees with `http-post-content`.
 *
 * Selectors (`fixed`, `byExtension`, `byPayloadField`) are facet-local
 * — they pick which leaf runs for a given output and have no
 * decode-side dual.
 */

import type { PayloadResponseMap } from "./service.ts";
import type { ContentResponseInit } from "../codecs/codec.ts";
import { json as jsonCodec } from "../codecs/json.ts";
import { text as textCodec } from "../codecs/text.ts";
import { raw as rawCodec } from "../codecs/raw.ts";
import { field as fieldCodec } from "../codecs/field.ts";

/** `JSON.stringify(payload)` + `application/json`. */
function json(): PayloadResponseMap {
  return jsonCodec().encode;
}

/** Payload (string) → body with the given content-type (default `text/plain`). */
function text(contentType?: string): PayloadResponseMap {
  return textCodec(contentType).encode;
}

/** Payload (Uint8Array / ArrayBuffer / string) → body with the given content-type. */
function raw(contentType: string): PayloadResponseMap {
  return rawCodec(contentType).encode;
}

/**
 * Body = `payload[name]`, Content-Type = `opts.contentType` (or the
 * payload's own `contentTypeField` when configured — see
 * `src/codecs/field.ts`).
 */
function fromField(
  name: string,
  opts: { contentType?: string; contentTypeField?: string },
): PayloadResponseMap {
  return fieldCodec(name, {
    defaultContentType: opts.contentType,
    contentTypeField: opts.contentTypeField,
  }).encode;
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
  text,
  raw,
  fromField,
  fixed,
  byExtension,
  byPayloadField,
};
