/**
 * @module
 * HTTP API for the Rig.
 *
 * Standalone function that translates HTTP requests to rig method calls.
 * No framework dependency, no middleware — just a `(Request) => Promise<Response>`.
 *
 * The rig stays pure (orchestration only). Transport is external.
 *
 * Routes (mirror the `ProtocolInterfaceNode` surface — every body is a
 * bare array, exactly the argument the corresponding PIN method takes):
 *
 *   GET  /api/v1/status     → rig.status()
 *   POST /api/v1/receive    → rig.receive(msgs)        body: [[uri, payload], ...]
 *   POST /api/v1/read       → rig.read(urls)           body: string[]
 *   POST /api/v1/observe    → rig.observe(urls)        body: string[]   (NDJSON stream)
 *
 * Observe streams one JSON-encoded `string[]` (batch of uris that
 * fired) per line, matching what `rig.observe()` yields.
 *
 * Wire-adapter failures (bad JSON, schema mismatch) throw `BadRequest`
 * — see `src/router/errors.ts`. The dispatcher catches and renders as
 * `Response(message, { status })` with a plain-text body. No envelope:
 * status carries the category, body carries the message.
 *
 * @example
 * ```ts
 * import { Rig, connection } from "@bandeira-tech/b3nd-core";
 * import { httpApi } from "@bandeira-tech/b3nd-move/http/service";
 *
 * const c = connection(client, ["*"]);
 * const rig = new Rig({ routes: { receive: [c], read: [c], observe: [c] } });
 * Deno.serve({ port: 3000 }, httpApi(rig));
 * ```
 *
 * @example Hono (CORS, middleware, etc.)
 * ```ts
 * const api = httpApi(rig, { statusMeta: { version: "1.0" } });
 * const app = new Hono();
 * app.use("*", cors({ origin: "*" }));
 * app.all("/api/*", (c) => api(c.req.raw));
 * ```
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import { ndjsonResponse } from "../actions/ndjson.ts";
import { validateOutputs, validateUrls } from "../actions/validate.ts";
import { BadRequest } from "../router/errors.ts";
import { dispatchHttp, type HttpRoute, route } from "../router/http.ts";

// ── Types ──

export interface HttpApiOptions {
  /** Extra metadata merged into status responses. */
  statusMeta?: Record<string, unknown>;
}

// ── Helpers ──

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BadRequest("Invalid JSON body");
  }
}

// ── Routes ──

function buildRoutes(options?: HttpApiOptions): HttpRoute[] {
  const statusMeta = options?.statusMeta;

  return [
    route({
      on: { method: "GET", path: "/api/v1/status" },
      action: "status",
      decode: () => [],
      encode: (res) => {
        const body = statusMeta ? { ...res, ...statusMeta } : res;
        return json(body, res.status === "healthy" ? 200 : 503);
      },
    }),

    // 200 with per-slot ReceiveResult body. Per-slot reject is a
    // domain outcome, not a transport failure — request-level failures
    // (bad JSON, schema mismatch) throw `BadRequest` and surface as
    // plain-text 400.
    route({
      on: { method: "POST", path: "/api/v1/receive" },
      action: "receive",
      decode: async (req) => {
        const body = await readJson(req);
        const v = validateOutputs(body);
        if (!v.ok) throw new BadRequest(v.error);
        return [v.value];
      },
      encode: (results) => json(results, 200),
    }),

    // Output[] 1:1 with input. Content semantics are the protocol's.
    route({
      on: { method: "POST", path: "/api/v1/read" },
      action: "read",
      decode: async (req) => {
        const body = await readJson(req);
        const v = validateUrls(body);
        if (!v.ok) throw new BadRequest(v.error);
        return [v.value];
      },
      encode: (outs) => json(outs, 200),
    }),

    // NDJSON stream. ctx.abort is wired to req.signal by the dispatcher;
    // ndjsonResponse fires it again on consumer cancel, propagating to
    // the rig observer.
    route({
      on: { method: "POST", path: "/api/v1/observe" },
      action: "observe",
      decode: async (req) => {
        const body = await readJson(req);
        const v = validateUrls(body);
        if (!v.ok) throw new BadRequest(v.error);
        return [v.value];
      },
      encode: (frames, ctx) =>
        ndjsonResponse(frames, ctx.abort, undefined, {
          "X-Accel-Buffering": "no",
        }),
    }),
  ];
}

// ── API factory ──

/**
 * Create an HTTP request handler backed by a Rig.
 *
 * Returns a standard `(Request) => Promise<Response>` — plug it
 * into Deno.serve, Hono, or any other HTTP framework.
 */
export function httpApi(
  rig: Rig,
  options?: HttpApiOptions,
): (req: Request) => Promise<Response> {
  const routes = buildRoutes(options);
  return (req) => dispatchHttp(rig, routes, req);
}
