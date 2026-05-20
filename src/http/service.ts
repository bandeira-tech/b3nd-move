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
 * Implementation: each route is a `HttpRoute` (see `src/router/http.ts`)
 * with a declarative `on: { method, path }` matcher. `dispatchHttp`
 * walks the table — no procedural if-ladder. Wrong method on a known
 * path gets a `405` with `Allow:` from the dispatcher; unknown paths
 * get `404`.
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
import type { ActionCall } from "../actions/run.ts";
import { runAction } from "../actions/run.ts";
import { validateOutputs, validateUrls } from "../actions/validate.ts";
import { dispatchHttp, type HttpRoute } from "../router/http.ts";

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

async function readJson(
  req: Request,
  onInvalid: (msg: string) => Response,
): Promise<unknown | Response> {
  try {
    return await req.json();
  } catch {
    return onInvalid("Invalid JSON body");
  }
}

// Narrow an `ActionCall` to a specific action variant. Routes know
// which they built; this just gets TS to agree without per-site
// inline casts.
function narrow<A extends ActionCall["action"]>(
  call: ActionCall,
  _action: A,
): Extract<ActionCall, { action: A }> {
  return call as Extract<ActionCall, { action: A }>;
}

// ── Routes ──

function buildRoutes(options?: HttpApiOptions): HttpRoute[] {
  const statusMeta = options?.statusMeta;

  const status: HttpRoute = {
    on: { method: "GET", path: "/api/v1/status" },
    build: () => ({ action: "status" }),
    respond: async (rig) => {
      const res = await runAction(rig, { action: "status" });
      const body = statusMeta ? { ...res, ...statusMeta } : res;
      return json(body, res.status === "healthy" ? 200 : 503);
    },
  };

  // 200 with per-slot ReceiveResult body; non-2xx is reserved for
  // request-level failures (bad JSON, schema mismatch).
  const receive: HttpRoute = {
    on: { method: "POST", path: "/api/v1/receive" },
    build: async (req) => {
      const body = await readJson(
        req,
        (msg) => json([{ accepted: false, error: msg }], 400),
      );
      if (body instanceof Response) return body;
      const v = validateOutputs(body);
      if (!v.ok) return json([{ accepted: false, error: v.error }], 400);
      return { action: "receive", outputs: v.value };
    },
    respond: async (rig, _req, call) => {
      const results = await runAction(rig, narrow(call, "receive"));
      return json(results, 200);
    },
  };

  // Output[] 1:1 with input. Content semantics are the protocol's.
  const read: HttpRoute = {
    on: { method: "POST", path: "/api/v1/read" },
    build: async (req) => {
      const body = await readJson(req, (msg) => json({ error: msg }, 400));
      if (body instanceof Response) return body;
      const v = validateUrls(body);
      if (!v.ok) return json({ error: v.error }, 400);
      return { action: "read", urls: v.value };
    },
    respond: async (rig, _req, call) => {
      try {
        return json(await runAction(rig, narrow(call, "read")));
      } catch (err) {
        return json(
          { error: err instanceof Error ? err.message : String(err) },
          500,
        );
      }
    },
  };

  // NDJSON stream of frames. Action signal is ndjsonResponse's
  // internal abort — consumer cancel + request abort both reach the
  // rig observer.
  const observe: HttpRoute = {
    on: { method: "POST", path: "/api/v1/observe" },
    build: async (req) => {
      const body = await readJson(req, (msg) => json({ error: msg }, 400));
      if (body instanceof Response) return body;
      const v = validateUrls(body);
      if (!v.ok) return json({ error: v.error }, 400);
      // Placeholder signal; respond replaces it with ndjsonResponse's.
      return { action: "observe", urls: v.value, signal: req.signal };
    },
    respond: (rig, req, call) => {
      const obs = narrow(call, "observe");
      return ndjsonResponse(
        (signal) =>
          runAction(rig, { action: "observe", urls: obs.urls, signal }),
        (frame) => frame,
        req.signal,
        { "X-Accel-Buffering": "no" },
      );
    },
  };

  return [status, receive, read, observe];
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
