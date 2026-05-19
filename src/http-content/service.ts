/**
 * @module
 * Read-side HTTP content facet.
 *
 * Specialized request frontend that fronts `rig.read` for a single URI
 * with a host-controlled mapping from `(request, output)` → HTTP response
 * shape. Use this when you need the read surface to be cacheable,
 * embeddable, or otherwise reachable by clients that can't speak the
 * generic `httpApi` JSON-POST wire (a browser `<img src>`, a CDN, an
 * SDK that wants `Content-Type: image/png` instead of opaque JSON).
 *
 * Route:
 *
 *   GET /api/v1/content/<url-encoded-uri>   → rig.read([uri])  (single)
 *
 * The whole content-type / body-bytes / extra-headers decision lives in
 * one hook — `payloadResponseMap(req, output) => ContentResponseInit` —
 * supplied at instantiation. Common policies ship as composable helpers
 * on the {@link payloadResponseMap} object: `json`, `raw`, `fromField`,
 * `fixed`, `byExtension`, `byPayloadField`.
 *
 * @example
 * ```ts
 * import { httpGetContentApi, payloadResponseMap as map }
 *   from "@bandeira-tech/b3nd-move/http-content/service";
 *
 * Deno.serve({ port: 3000 }, httpGetContentApi(rig, {
 *   payloadResponseMap: map.byExtension({
 *     png:  map.fromField("bytes", { contentType: "image/png" }),
 *     json: map.json(),
 *     "*":  map.json(),
 *   }),
 * }));
 * ```
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import type { Output } from "@bandeira-tech/b3nd-core/types";

// ── Types ──

/** Response state the hook injects; the facet assembles the `Response`. */
export interface ContentResponseInit {
  body: BodyInit;
  headers?: HeadersInit;
  /** Defaults to 200. */
  status?: number;
}

/**
 * Decides how a successful `rig.read` output becomes an HTTP response.
 * Owns content-type, body bytes, and any extra headers in one place.
 */
export type PayloadResponseMap = (
  req: Request,
  output: Output,
) => Promise<ContentResponseInit>;

export interface HttpGetContentApiOptions {
  /** Required. Maps `(req, output)` → response state. */
  payloadResponseMap: PayloadResponseMap;
}

const PREFIX = "/api/v1/content/";

// ── API factory ──

/**
 * Create a GET-only HTTP handler that reads a single URI from the rig
 * and hands the result to `payloadResponseMap` for response shaping.
 *
 * - `GET /api/v1/content/<encoded-uri>` → `rig.read([decoded-uri])` → hook → 200
 * - rig.read throws                    → 500
 * - hook throws                        → 500
 * - missing / malformed path           → 404 / 400
 * - non-GET                            → 405
 *
 * Miss semantics (e.g. payload `null` = 404 vs payload `null` = 200 with
 * a sentinel body) are the host's call — handle them inside your
 * `payloadResponseMap`. The facet never second-guesses payload contents.
 */
export function httpGetContentApi(
  rig: Rig,
  options: HttpGetContentApiOptions,
): (req: Request) => Promise<Response> {
  const { payloadResponseMap } = options;

  return async (req: Request): Promise<Response> => {
    if (req.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET" },
      });
    }

    const path = new URL(req.url).pathname;
    if (!path.startsWith(PREFIX) || path.length === PREFIX.length) {
      return new Response("Not Found", { status: 404 });
    }

    let uri: string;
    try {
      uri = decodeURIComponent(path.slice(PREFIX.length));
    } catch {
      return new Response("Bad Request: invalid URI encoding", { status: 400 });
    }

    let output: Output;
    try {
      const results = await rig.read([uri]);
      output = results[0];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`read failed: ${msg}`, { status: 500 });
    }
    if (!output) return new Response("Not Found", { status: 404 });

    let init: ContentResponseInit;
    try {
      init = await payloadResponseMap(req, output);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`payloadResponseMap failed: ${msg}`, { status: 500 });
    }

    return new Response(init.body, {
      status: init.status ?? 200,
      headers: init.headers,
    });
  };
}

// ── Composable helpers ──

function json(): PayloadResponseMap {
  return async (_req, [, payload]) => ({
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });
}

function raw(contentType: string): PayloadResponseMap {
  return async (_req, [, payload]) => {
    if (
      !(payload instanceof Uint8Array) &&
      !(payload instanceof ArrayBuffer) &&
      typeof payload !== "string"
    ) {
      throw new TypeError(
        `raw(${contentType}): payload must be Uint8Array, ArrayBuffer, or string`,
      );
    }
    return {
      body: payload as BodyInit,
      headers: { "Content-Type": contentType },
    };
  };
}

function fromField(
  name: string,
  opts: { contentType: string },
): PayloadResponseMap {
  return async (_req, [, payload]) => {
    if (payload == null || typeof payload !== "object") {
      throw new TypeError(`fromField(${name}): payload must be an object`);
    }
    const value = (payload as Record<string, unknown>)[name];
    if (value == null) {
      throw new TypeError(`fromField(${name}): missing field "${name}"`);
    }
    return {
      body: value as BodyInit,
      headers: { "Content-Type": opts.contentType },
    };
  };
}

function fixed(init: ContentResponseInit): PayloadResponseMap {
  return async () => init;
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

/**
 * Composable building blocks for {@link PayloadResponseMap}.
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
export const payloadResponseMap = {
  json,
  raw,
  fromField,
  fixed,
  byExtension,
  byPayloadField,
};
