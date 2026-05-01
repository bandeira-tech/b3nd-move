/**
 * @module
 * gRPC-HTTP service — B3ndService as a fetch handler.
 *
 * Routes:
 *   POST /b3nd.v1.B3ndService/Receive  → rig.receive()
 *   POST /b3nd.v1.B3ndService/Read     → rig.read()
 *   POST /b3nd.v1.B3ndService/Observe  → rig.observe() — NDJSON stream
 *   POST /b3nd.v1.B3ndService/Status   → rig.status()
 *
 * Encoding is negotiated by Content-Type:
 *   application/json, application/connect+json    → JSON  (default)
 *   application/proto, application/connect+proto,
 *   application/grpc, application/grpc-web+proto  → binary protobuf
 *
 * @bufbuild/protobuf handles bytes ↔ base64 automatically in JSON mode —
 * no manual base64 is needed anywhere in this file.
 *
 * Observe always streams NDJSON regardless of encoding; the connectrpc
 * streaming envelope format is not implemented here.
 *
 * Unary methods (Receive, Read, Status) are compatible with
 * @connectrpc/connect-web out of the box — use
 *   createClient(B3ndService, createConnectTransport({ baseUrl }))
 */

import { create, fromBinary, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import type { JsonValue } from "@bufbuild/protobuf";
import type { Rig } from "@bandeira-tech/b3nd-core";
import {
  readResultToProto,
  receiveRequestToMessage,
  receiveResultToResponse,
  statusResultToResponse,
} from "../b3nd-proto/convert.ts";
import {
  ObserveRequestSchema,
  ReadRequestSchema,
  ReadResponseSchema,
  ReadResultProtoSchema,
  ReceiveRequestSchema,
  ReceiveResponseSchema,
  StatusResponseSchema,
} from "../b3nd-proto/gen/b3nd_pb.ts";

const SERVICE_PREFIX = "/b3nd.v1.B3ndService/";

type Encoding = "json" | "binary";

function detectEncoding(req: Request): Encoding {
  const ct = req.headers.get("content-type") ?? "";
  if (
    ct.startsWith("application/connect+proto") ||
    ct.startsWith("application/proto") ||
    ct.startsWith("application/grpc")
  ) return "binary";
  return "json";
}

function okResponse(body: BodyInit, enc: Encoding): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": enc === "binary" ? "application/proto" : "application/json",
    },
  });
}

function errResponse(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Create a gRPC-HTTP request handler.
 *
 * Returns a standard `(Request) => Promise<Response>` — plug into
 * `Deno.serve`, `withCors()`, or any fetch-compatible HTTP runtime.
 */
export function grpcHttpApi(rig: Rig): (req: Request) => Promise<Response> {
  return (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (req.method !== "POST" || !path.startsWith(SERVICE_PREFIX)) {
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }
    const method = path.slice(SERVICE_PREFIX.length);
    const enc = detectEncoding(req);
    switch (method) {
      case "Receive": return handleReceive(rig, req, enc);
      case "Read":    return handleRead(rig, req, enc);
      case "Observe": return handleObserve(rig, req);
      case "Status":  return handleStatus(rig, enc);
      default:        return Promise.resolve(errResponse(`Unknown method: ${method}`, 404));
    }
  };
}

async function handleReceive(rig: Rig, req: Request, enc: Encoding): Promise<Response> {
  let body;
  try {
    body = enc === "binary"
      ? fromBinary(ReceiveRequestSchema, new Uint8Array(await req.arrayBuffer()))
      : fromJson(ReceiveRequestSchema, await req.json() as JsonValue);
  } catch {
    return errResponse("Invalid request body");
  }
  if (!body.uri) return errResponse("uri is required");

  const [result] = await rig.receive([receiveRequestToMessage(body)]);
  const response = receiveResultToResponse(result);
  return okResponse(
    enc === "binary" ? toBinary(ReceiveResponseSchema, response) : JSON.stringify(toJson(ReceiveResponseSchema, response)),
    enc,
  );
}

async function handleRead(rig: Rig, req: Request, enc: Encoding): Promise<Response> {
  let body;
  try {
    body = enc === "binary"
      ? fromBinary(ReadRequestSchema, new Uint8Array(await req.arrayBuffer()))
      : fromJson(ReadRequestSchema, await req.json() as JsonValue);
  } catch {
    return errResponse("Invalid request body");
  }
  if (!body.uris?.length) return errResponse("uris array is required");

  const results = await rig.read(body.uris);
  const response = create(ReadResponseSchema, { results: results.map(readResultToProto) });
  return okResponse(
    enc === "binary" ? toBinary(ReadResponseSchema, response) : JSON.stringify(toJson(ReadResponseSchema, response)),
    enc,
  );
}

async function handleObserve(rig: Rig, req: Request): Promise<Response> {
  let body;
  try {
    body = fromJson(ObserveRequestSchema, await req.json() as JsonValue);
  } catch {
    return errResponse("Invalid request body");
  }
  if (!body.pattern) return errResponse("pattern is required");

  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());
  const textEnc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const result of rig.observe(body.pattern, abort.signal)) {
          if (abort.signal.aborted) break;
          const proto = readResultToProto(result);
          controller.enqueue(
            textEnc.encode(JSON.stringify(toJson(ReadResultProtoSchema, proto)) + "\n"),
          );
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          const msg = e instanceof Error ? e.message : String(e);
          controller.enqueue(textEnc.encode(JSON.stringify({ error: msg }) + "\n"));
        }
      } finally {
        controller.close();
      }
    },
    cancel() { abort.abort(); },
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

async function handleStatus(rig: Rig, enc: Encoding): Promise<Response> {
  const result = await rig.status();
  const response = statusResultToResponse(result);
  return okResponse(
    enc === "binary" ? toBinary(StatusResponseSchema, response) : JSON.stringify(toJson(StatusResponseSchema, response)),
    enc,
  );
}
