/**
 * gRPC-HTTP transport stub for browser integration tests.
 *
 * Speaks the same content-addressed echo contract documented in
 * `tests/runners/move-suite.ts`, exposed over the Connect-style routes
 * `GrpcHttpClient` calls:
 *
 *   POST /b3nd.v1.B3ndService/Receive  → ReceiveResponse JSON
 *   POST /b3nd.v1.B3ndService/Read     → ReadResponse JSON
 *   POST /b3nd.v1.B3ndService/Status   → StatusResponse JSON
 *   POST /b3nd.v1.B3ndService/Observe  → NDJSON stream of OutputProto
 *
 * The stub only implements the JSON encoding (default for the client).
 * Binary protobuf would require pulling in the proto schemas; the move
 * layer's encode/decode path is identical at the byte level after the
 * Content-Type branch, so JSON is sufficient to exercise it.
 *
 * Proto3 JSON conventions used here:
 *   - `bytes` fields are base64-encoded strings (UTF-8 JSON payload bytes
 *     are JSON-stringified first, then base64'd).
 *   - field names are camelCase (`payloadIsBinary`, `fnsJson`).
 *   - missing scalar fields default per proto3 (empty string, false).
 */

/// <reference lib="deno.ns" />

import type { StubServerHandle } from "../browser-runner.ts";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "86400",
  "access-control-allow-private-network": "true",
};

const SERVICE_PREFIX = "/b3nd.v1.B3ndService/";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors },
  });
}

function preflight(): Response {
  return new Response(null, { status: 204, headers: cors });
}

/** Encode an arbitrary value as the JSON-bytes-as-base64 payload form. */
function payloadJsonBase64(value: unknown): string {
  // JSON.stringify always returns ASCII-safe text (non-ASCII is escaped),
  // so plain `btoa` is sufficient.
  return btoa(JSON.stringify(value));
}

function receiveOneJson(uri: string): { accepted: boolean; error: string } {
  if (uri.includes("/__reject__/")) {
    return { accepted: false, error: "rejected by stub" };
  }
  return { accepted: true, error: "" };
}

/** Build an OutputProto JSON object for a read result. */
function readOneJson(url: string): {
  uri: string;
  payload: string;
  payloadIsBinary: boolean;
} {
  if (url.includes("/__miss__/")) {
    // Empty bytes → outputFromProto decodes empty JSON → undefined.
    return { uri: url, payload: "", payloadIsBinary: false };
  }
  return {
    uri: url,
    payload: payloadJsonBase64({ echo: url }),
    payloadIsBinary: false,
  };
}

/** Start the gRPC-HTTP stub server. Listens on a kernel-assigned port. */
export function startGrpcStub(): Promise<StubServerHandle> {
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      if (method === "OPTIONS") return preflight();
      if (method !== "POST" || !path.startsWith(SERVICE_PREFIX)) {
        return new Response("not found", { status: 404, headers: cors });
      }
      const rpc = path.slice(SERVICE_PREFIX.length);

      if (rpc === "Status") {
        return jsonResponse({
          status: "healthy",
          message: "stub",
          schemaJson: "",
          fnsJson: JSON.stringify(["receive", "read", "observe", "status"]),
          detailsJson: "",
        });
      }

      if (rpc === "Receive") {
        let body: { messages?: Array<{ uri?: string }> };
        try {
          body = await req.json();
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, 400);
        }
        const messages = body.messages ?? [];
        const results = messages.map((m) =>
          typeof m?.uri === "string"
            ? receiveOneJson(m.uri)
            : { accepted: false, error: "URI is required" }
        );
        return jsonResponse({ results });
      }

      if (rpc === "Read") {
        let body: { urls?: unknown };
        try {
          body = await req.json();
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, 400);
        }
        // Proto3 JSON omits empty repeated fields by default, so an
        // empty-batch request arrives as `{}`. Treat missing as [].
        const urls = body.urls ?? [];
        if (
          !Array.isArray(urls) || !urls.every((u) => typeof u === "string")
        ) {
          return jsonResponse({ error: "Expected { urls: string[] }" }, 400);
        }
        return jsonResponse({
          results: (urls as string[]).map(readOneJson),
        });
      }

      if (rpc === "Observe") {
        let body: { urls?: unknown };
        try {
          body = await req.json();
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, 400);
        }
        const urls = body.urls ?? [];
        if (
          !Array.isArray(urls) || !urls.every((u) => typeof u === "string")
        ) {
          return jsonResponse({ error: "Expected { urls: string[] }" }, 400);
        }
        return ndjsonObserve(urls as string[], req.signal);
      }

      return new Response("unknown rpc", { status: 404, headers: cors });
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

/** Emit three NDJSON frames per subscribed pattern, then close. */
function ndjsonObserve(patterns: string[], signal: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const cleanup = () => {
        try {
          controller.close();
        } catch { /* already closed */ }
      };
      signal.addEventListener("abort", cleanup, { once: true });
      try {
        for (const pattern of patterns) {
          for (let i = 0; i < 3; i++) {
            if (signal.aborted) return;
            // Each emitted frame is an OutputProto JSON line:
            // uri = subscribed pattern, payload = JSON-bytes of [child uri].
            const frame = {
              uri: pattern,
              payload: payloadJsonBase64([`${pattern}/${i}`]),
              payloadIsBinary: false,
            };
            controller.enqueue(enc.encode(`${JSON.stringify(frame)}\n`));
          }
        }
      } catch {
        // Stream may already be closed.
      }
      cleanup();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache",
      ...cors,
    },
  });
}
