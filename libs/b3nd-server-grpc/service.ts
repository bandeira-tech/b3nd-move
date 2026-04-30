/**
 * @module
 * gRPC service adapter — translates RPC calls to rig primitives.
 *
 * Uses the Connect protocol (JSON over HTTP/2) served by Deno.serve.
 * Each RPC is a POST to `/b3nd.v1.B3ndService/{Method}` with JSON body.
 * Server-streaming (Observe) uses newline-delimited JSON (NDJSON).
 *
 * This avoids protobuf codegen while remaining wire-compatible with
 * Connect clients. The proto file is the canonical schema for external
 * tools (grpcurl, buf curl, etc.).
 */

import type { Rig } from "@bandeira-tech/b3nd-core";
import {
  readResultToProto,
  receiveRequestToMessage,
  receiveResultToResponse,
  statusResultToResponse,
} from "../b3nd-proto/convert.ts";
import type {
  ObserveRequest,
  ReadRequest,
  ReadResponse,
  ReceiveRequest,
  ReceiveResponse,
  StatusResponse,
} from "../b3nd-proto/schema.ts";

const SERVICE_PREFIX = "/b3nd.v1.B3ndService/";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

/**
 * Create a gRPC request handler — the gRPC counterpart to `httpApi(rig)`.
 *
 * Returns a standard `(Request) => Promise<Response>`. Plug it into
 * `Deno.serve`, `withCors()`, or any HTTP runtime.
 *
 * Routes:
 *   POST /b3nd.v1.B3ndService/Receive  → rig.receive()
 *   POST /b3nd.v1.B3ndService/Read     → rig.read()
 *   POST /b3nd.v1.B3ndService/Observe  → rig.observe() (NDJSON stream)
 *   POST /b3nd.v1.B3ndService/Status   → rig.status()
 */
export function grpcApi(
  rig: Rig,
): (req: Request) => Promise<Response> {
  return (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST" || !path.startsWith(SERVICE_PREFIX)) {
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }

    const method = path.slice(SERVICE_PREFIX.length);

    switch (method) {
      case "Receive":
        return handleReceive(rig, req);
      case "Read":
        return handleRead(rig, req);
      case "Observe":
        return handleObserve(rig, req);
      case "Status":
        return handleStatus(rig);
      default:
        return Promise.resolve(errorResponse(`Unknown method: ${method}`, 404));
    }
  };
}

async function handleReceive(rig: Rig, req: Request): Promise<Response> {
  let body: ReceiveRequest;
  try {
    body = await req.json() as ReceiveRequest;
  } catch {
    return errorResponse("Invalid JSON body");
  }

  if (!body.uri) {
    return errorResponse("uri is required");
  }

  // Decode base64 data field if present as string (JSON transport)
  if (typeof body.data === "string") {
    body.data = base64ToBytes(body.data);
  }

  const msg = receiveRequestToMessage(body);
  const results = await rig.receive([msg]);
  const response: ReceiveResponse = receiveResultToResponse(results[0]);
  return jsonResponse(response);
}

async function handleRead(rig: Rig, req: Request): Promise<Response> {
  let body: ReadRequest;
  try {
    body = await req.json() as ReadRequest;
  } catch {
    return errorResponse("Invalid JSON body");
  }

  if (!body.uris || body.uris.length === 0) {
    return errorResponse("uris array is required");
  }

  const results = await rig.read(body.uris);
  const response: ReadResponse = {
    results: results.map((r) => {
      const proto = readResultToProto(r);
      // Encode bytes as base64 for JSON transport
      if (proto.record?.data) {
        (proto.record as unknown as Record<string, unknown>).data =
          bytesToBase64(
            proto.record.data,
          );
      }
      return proto;
    }),
  };
  return jsonResponse(response);
}

async function handleObserve(rig: Rig, req: Request): Promise<Response> {
  let body: ObserveRequest;
  try {
    body = await req.json() as ObserveRequest;
  } catch {
    return errorResponse("Invalid JSON body");
  }

  if (!body.pattern) {
    return errorResponse("pattern is required");
  }

  const abortController = new AbortController();

  // Link request signal to our abort controller
  req.signal.addEventListener("abort", () => abortController.abort());

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (
          const result of rig.observe(body.pattern, abortController.signal)
        ) {
          if (abortController.signal.aborted) break;
          const proto = readResultToProto(result);
          // Encode bytes as base64 for JSON transport
          if (proto.record?.data) {
            (proto.record as unknown as Record<string, unknown>).data =
              bytesToBase64(
                proto.record.data,
              );
          }
          controller.enqueue(encoder.encode(JSON.stringify(proto) + "\n"));
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          const errMsg = err instanceof Error ? err.message : String(err);
          controller.enqueue(
            encoder.encode(JSON.stringify({ error: errMsg }) + "\n"),
          );
        }
      } finally {
        controller.close();
      }
    },
    cancel() {
      abortController.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

async function handleStatus(rig: Rig): Promise<Response> {
  const result = await rig.status();
  const response: StatusResponse = statusResultToResponse(result);
  return jsonResponse(response, result.status === "healthy" ? 200 : 503);
}

// ── Base64 helpers ──────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  const binString = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binString);
}

function base64ToBytes(base64: string): Uint8Array {
  const binString = atob(base64);
  return Uint8Array.from(binString, (c) => c.charCodeAt(0));
}
