/**
 * @module
 * HTTP API for the Rig.
 *
 * Standalone function that translates HTTP requests to rig method calls.
 * No framework dependency, no middleware — just a `(Request) => Promise<Response>`.
 *
 * The rig stays pure (orchestration only). Transport is external.
 *
 * Routes:
 *   GET  /api/v1/status                → rig.status()
 *   POST /api/v1/receive               → rig.receive([[uri, payload]])
 *   POST /api/v1/read                  → rig.read(urls)   body: { urls }
 *   GET  /api/v1/observe/:pattern       → INV-style SSE stream (uri only)
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
import type { RigEvent } from "@bandeira-tech/b3nd-core/rig";

// ── Types ──

export interface HttpApiOptions {
  /** Extra metadata merged into status responses. */
  statusMeta?: Record<string, unknown>;
}

// ── URI helpers ──

/** Extract a b3nd URI from the request path after a prefix. */
function extractUri(path: string, prefix: string): string | null {
  // /api/v1/read/mutable/open/test → mutable://open/test
  // /api/v1/read/mutable/open/test/ → mutable://open/test/ (trailing slash preserved)
  const rest = path.slice(prefix.length);
  if (!rest) return null;
  const hasTrailingSlash = rest.endsWith("/");
  const parts = rest.split("/").filter(Boolean);
  if (parts.length < 2) {
    // protocol-only: /api/v1/read/mutable → mutable://
    return parts.length === 1 ? `${parts[0]}://` : null;
  }
  const protocol = parts[0];
  const domain = parts[1];
  const subpath = parts.slice(2).join("/");
  const uri = subpath
    ? `${protocol}://${domain}/${subpath}`
    : `${protocol}://${domain}`;
  return hasTrailingSlash ? `${uri}/` : uri;
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
 *
 * SSE subscriptions are powered by rig events — when `rig.receive()`
 * or `rig.send()` succeeds, SSE subscribers with matching prefixes
 * receive the event in real-time.
 *
 * @example
 * ```ts
 * import { Rig, connection } from "@b3nd/rig";
 * import { httpApi } from "@b3nd/rig/http";
 *
 * const c = connection(client, ["*"]);
 * const rig = new Rig({ routes: { receive: [c], read: [c], observe: [c] } });
 * const api = httpApi(rig);
 * Deno.serve({ port: 3000 }, api);
 * ```
 */
export function httpApi(
  rig: Rig,
  options?: HttpApiOptions,
): (req: Request) => Promise<Response> {
  const statusMeta = options?.statusMeta;

  // ── SSE subscriber tracking ──
  // Each subscriber has a prefix and a write function.
  type SseSubscriber = {
    prefix: string;
    prefixSegments: string[];
    write: (text: string) => void;
    closed: boolean;
  };
  const subscribers = new Set<SseSubscriber>();

  // Wire rig events to SSE subscribers — INV-style, uri only.
  const pushToSubscribers = (e: RigEvent) => {
    if (!e.uri || subscribers.size === 0) return;
    const payload = `id: ${e.ts}\nevent: write\ndata: ${
      JSON.stringify({ uri: e.uri })
    }\n\n`;
    for (const sub of subscribers) {
      if (sub.closed) continue;
      // Prefix match — subscriber's prefix must be a prefix of the URI
      if (e.uri.startsWith(sub.prefix) || sub.prefix === "*") {
        sub.write(payload);
      }
    }
  };
  rig.on("receive:success", pushToSubscribers);
  rig.on("send:success", pushToSubscribers);

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // ── Status (replaces health + schema) ──
    if (
      method === "GET" &&
      (path === "/api/v1/status" || path === "/api/v1/health")
    ) {
      const res = await rig.status();
      const body = statusMeta ? { ...res, ...statusMeta } : res;
      return json(body, res.status === "healthy" ? 200 : 503);
    }

    // ── Schema (derived from status) ──
    if (method === "GET" && path === "/api/v1/schema") {
      const res = await rig.status();
      return json({ schema: res.schema ?? [] });
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
      // Decomposition is a protocol concern (install messageDataProgram +
      // messageDataHandler on the Rig if you want envelope semantics);
      // SimpleClient/DataStoreClient never decompose on their own.
      const results = await rig.receive(batch);
      // 200 means the server processed the batch; per-slot accept/reject
      // lives in the body. Non-2xx is reserved for request-level failures.
      return json(results, 200);
    }

    // ── Read (batch) ──
    // Body: `{ urls: string[] }`. Returns `Output[]` = `[[uri, payload], ...]`
    // 1:1 with input urls. Payloads pass through as JSON — content
    // semantics (miss representation, binary encoding, etc.) are the
    // executing client / protocol's concern.
    if (method === "POST" && path === "/api/v1/read") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      const urls = (body as { urls?: unknown })?.urls;
      if (!Array.isArray(urls) || !urls.every((u) => typeof u === "string")) {
        return json({ error: "Expected { urls: string[] }" }, 400);
      }
      try {
        return json(await rig.read(urls as string[]));
      } catch (err) {
        return json(
          { error: err instanceof Error ? err.message : String(err) },
          500,
        );
      }
    }

    // ── SSE Observe ──
    if (method === "GET" && path.startsWith("/api/v1/observe/")) {
      const uri = extractUri(path, "/api/v1/observe/");
      if (!uri) return json({ error: "Invalid URI" }, 400);

      // TODO: wire since/?since= + Last-Event-ID into SseSubscriber for SSE resume support

      const sub: SseSubscriber = {
        prefix: uri,
        prefixSegments: uri.split("/"),
        write: () => {},
        closed: false,
      };

      const body = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          sub.write = (text: string) => {
            if (sub.closed) return;
            try {
              controller.enqueue(encoder.encode(text));
            } catch {
              sub.closed = true;
            }
          };
          subscribers.add(sub);

          // Send backlog of uris under the prefix as INV events. The
          // observer reads each uri to learn its current state. The
          // ls payload is `Output[]`; iterate its first elements.
          (async () => {
            try {
              const listUri = uri.endsWith("/") ? uri : `${uri}/`;
              const [result] = await rig.read<Array<[string, unknown]>>([
                listUri,
              ]);
              const entries = result?.[1] ?? [];
              for (const [outUri] of entries) {
                if (sub.closed) break;
                const now = Date.now();
                sub.write(
                  `id: ${now}\nevent: write\ndata: ${
                    JSON.stringify({ uri: outUri })
                  }\n\n`,
                );
              }
            } catch {
              // Backlog failed — continue with live events
            }
          })();

          // Keep-alive ping
          const keepAlive = setInterval(() => {
            sub.write(": keepalive\n\n");
          }, 30_000);

          // Store cleanup for cancel
          (controller as unknown as { _cleanup: () => void })._cleanup = () => {
            sub.closed = true;
            subscribers.delete(sub);
            clearInterval(keepAlive);
          };
        },
        cancel(controller) {
          (controller as unknown as { _cleanup?: () => void })._cleanup?.();
          sub.closed = true;
          subscribers.delete(sub);
        },
      });

      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
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
