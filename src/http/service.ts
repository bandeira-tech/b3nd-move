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
 * Observe streams one JSON-encoded `[pattern, uris[]]` frame per line,
 * matching what `rig.observe()` yields.
 *
 * @example
 * ```ts
 * import { Rig, connection } from "@b3nd/rig";
 * import { httpApi } from "@b3nd/rig/http";
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

// ── Types ──

export interface HttpApiOptions {
  /** Extra metadata merged into status responses. */
  statusMeta?: Record<string, unknown>;
}

// ── Responses ──

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
  const statusMeta = options?.statusMeta;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // ── Status ──
    if (method === "GET" && path === "/api/v1/status") {
      const res = await rig.status();
      const body = statusMeta ? { ...res, ...statusMeta } : res;
      return json(body, res.status === "healthy" ? 200 : 503);
    }

    // ── Receive ──
    // Body is a batch of message tuples: [[uri, payload], ...]. Matches
    // what HttpClient.receive(msgs) sends and what Rig.receive(msgs) takes,
    // so the result array shape passes straight through.
    if (method === "POST" && path === "/api/v1/receive") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(
          [{ accepted: false, error: "Invalid JSON body" }],
          400,
        );
      }
      if (
        !Array.isArray(body) || body.length === 0 ||
        !body.every((m) => Array.isArray(m) && m.length === 2)
      ) {
        return json(
          [{ accepted: false, error: "Expected [[uri, payload], ...]" }],
          400,
        );
      }
      const batch: [string, unknown][] = [];
      for (const [uri, rawPayload] of body as [unknown, unknown][]) {
        if (!uri || typeof uri !== "string") {
          return json(
            [{ accepted: false, error: "URI is required" }],
            400,
          );
        }
        batch.push([uri, rawPayload]);
      }
      const results = await rig.receive(batch);
      // 200 means the server processed the batch; per-slot accept/reject
      // lives in the body. Non-2xx is reserved for request-level failures.
      return json(results, 200);
    }

    // ── Read (batch) ──
    // Body: `string[]` — the same shape `rig.read(urls)` takes. Returns
    // `Output[]` 1:1 with input. Payloads pass through as JSON; content
    // semantics (miss representation, binary encoding, …) are the
    // executing client / protocol's concern.
    if (method === "POST" && path === "/api/v1/read") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      if (
        !Array.isArray(body) || body.length === 0 ||
        !body.every((u) => typeof u === "string")
      ) {
        return json({ error: "Expected string[]" }, 400);
      }
      try {
        return json(await rig.read(body as string[]));
      } catch (err) {
        return json(
          { error: err instanceof Error ? err.message : String(err) },
          500,
        );
      }
    }

    // ── Observe ──
    // Body: `string[]` — array of patterns to subscribe to, matching
    // `rig.observe(urls)`. Streams NDJSON: one JSON-encoded
    // `[pattern, uris[]]` frame per line.
    if (method === "POST" && path === "/api/v1/observe") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      if (
        !Array.isArray(body) || body.length === 0 ||
        !body.every((u) => typeof u === "string")
      ) {
        return json({ error: "Expected string[]" }, 400);
      }
      const urls = body as string[];

      const abort = new AbortController();
      req.signal.addEventListener("abort", () => abort.abort());
      const enc = new TextEncoder();

      const stream = new ReadableStream({
        async start(controller) {
          try {
            for await (const frame of rig.observe(urls, abort.signal)) {
              if (abort.signal.aborted) break;
              controller.enqueue(enc.encode(JSON.stringify(frame) + "\n"));
            }
          } catch (e) {
            if (!abort.signal.aborted) {
              const msg = e instanceof Error ? e.message : String(e);
              controller.enqueue(
                enc.encode(JSON.stringify({ error: msg }) + "\n"),
              );
            }
          } finally {
            controller.close();
          }
        },
        cancel() {
          abort.abort();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // ── Not found ──
    return new Response("Not Found", { status: 404 });
  };
}
