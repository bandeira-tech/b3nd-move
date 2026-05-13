/**
 * HTTP transport stub for browser integration tests.
 *
 * Implements the routes `HttpClient` calls and returns deterministic,
 * content-addressed responses per the stub contract documented in
 * `tests/runners/move-suite.ts`. There is NO rig and NO store — the
 * stub exists solely to drive the move layer's encode/decode/transport
 * path with batches on both sides.
 *
 * CORS: the stub server and the harness server bind to different
 * loopback ports — i.e. different origins — so cross-origin headers
 * are emitted on every response (including OPTIONS preflight).
 */

/// <reference lib="deno.ns" />

import type { StubServerHandle } from "../browser-runner.ts";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "86400",
  // Chrome's Private Network Access: a page served from 127.0.0.1
  // (harness) reaching another 127.0.0.1 port (stub) is "private
  // → private". Some Chrome versions still demand the preflight
  // opt-in even within loopback; this header is harmless on others.
  "access-control-allow-private-network": "true",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors },
  });
}

function plainResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...cors },
  });
}

function preflight(): Response {
  return new Response(null, { status: 204, headers: cors });
}

/** Per-message stub response: `/__reject__/` in uri → rejected. */
function receiveOne(
  uri: string,
): { accepted: boolean; ref?: string; error?: string } {
  if (uri.includes("/__reject__/")) {
    return { accepted: false, error: "rejected by stub" };
  }
  return { accepted: true, ref: uri };
}

/** Per-url stub response: `/__miss__/` in url → nullish payload. */
function readOne(url: string): [string, unknown] {
  if (url.includes("/__miss__/")) return [url, null];
  return [url, { echo: url }];
}

/** SSE encode helper — one `data: {json}\n\n` frame. */
function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function handleObserve(
  pattern: string,
  signal: AbortSignal,
): Response {
  // Emit three synthesized events per subscription, then close.
  // The HTTP client's SSE parser yields one frame per event, so this
  // alone proves multi-output for the observe channel.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const closeIfAborted = () => {
        if (signal.aborted) {
          try {
            controller.close();
          } catch { /* already closed */ }
        }
      };
      signal.addEventListener("abort", closeIfAborted, { once: true });
      try {
        for (let i = 0; i < 3; i++) {
          if (signal.aborted) break;
          controller.enqueue(
            enc.encode(sseFrame({
              uri: `${pattern}/${i}`,
              data: { echo: pattern, idx: i },
              ts: 1700000000000 + i,
            })),
          );
        }
      } catch {
        // Stream may already be closed.
      }
      try {
        controller.close();
      } catch { /* already closed */ }
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      ...cors,
    },
  });
}

/**
 * Convert the URL path after `/api/v1/observe/` back into a uri
 * pattern. Mirrors HttpClient's path-encoded uri: the first path
 * segment is the protocol (with `://` reattached), the rest is the
 * authority + path.
 */
function patternFromPath(path: string): string {
  const tail = path.slice("/api/v1/observe/".length);
  const slash = tail.indexOf("/");
  if (slash === -1) return `${tail}://`;
  const protocol = tail.slice(0, slash);
  const rest = tail.slice(slash + 1);
  return `${protocol}://${rest}`;
}

/** Start the HTTP stub server. Listens on a kernel-assigned port. */
export function startHttpStub(): Promise<StubServerHandle> {
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      if (method === "OPTIONS") return preflight();

      // /api/v1/health and /api/v1/status — interchangeable per the
      // real service.
      if (
        method === "GET" &&
        (path === "/api/v1/health" || path === "/api/v1/status")
      ) {
        return jsonResponse({
          status: "healthy",
          message: "stub",
          fns: ["receive", "read", "observe", "status"],
        });
      }

      if (method === "GET" && path === "/api/v1/schema") {
        return jsonResponse({ schema: [] });
      }

      if (method === "POST" && path === "/api/v1/receive") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return jsonResponse(
            [{ accepted: false, error: "Invalid JSON body" }],
            400,
          );
        }
        if (!Array.isArray(body)) {
          return jsonResponse(
            [{ accepted: false, error: "Expected [[uri, payload], ...]" }],
            400,
          );
        }
        const results = (body as [unknown, unknown][]).map(([uri]) =>
          typeof uri === "string"
            ? receiveOne(uri)
            : { accepted: false, error: "URI is required" }
        );
        // Per-message accept/reject lives in the body; status stays 200
        // so the client preserves slot-level detail. Matches the real
        // service contract.
        return jsonResponse(results, 200);
      }

      if (method === "POST" && path === "/api/v1/read") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, 400);
        }
        const urls = (body as { urls?: unknown })?.urls;
        if (
          !Array.isArray(urls) || !urls.every((u) => typeof u === "string")
        ) {
          return jsonResponse({ error: "Expected { urls: string[] }" }, 400);
        }
        return jsonResponse((urls as string[]).map(readOne));
      }

      if (method === "GET" && path.startsWith("/api/v1/observe/")) {
        const pattern = patternFromPath(path);
        return handleObserve(pattern, req.signal);
      }

      return plainResponse("not found", 404);
    },
  );
  return Promise.resolve({
    url: `http://127.0.0.1:${server.addr.port}`,
    stop: async () => {
      ac.abort();
      await server.finished;
    },
  });
}
