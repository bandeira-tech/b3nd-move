/**
 * @module
 * gRPC-HTTP service — B3ndService as a fetch handler.
 *
 * Routes:
 *   POST /b3nd.v1.B3ndService/Receive  → rig.receive(messages)
 *   POST /b3nd.v1.B3ndService/Read     → rig.read(urls)
 *   POST /b3nd.v1.B3ndService/Observe  → rig.observe(urls) — NDJSON stream
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

import {
  create,
  fromBinary,
  fromJson,
  toBinary,
  toJson,
} from "@bufbuild/protobuf";
import type { JsonValue } from "@bufbuild/protobuf";
import type { Rig } from "@bandeira-tech/b3nd-core";
import {
  outputFromProto,
  outputToProto,
  receiveResultToProto,
  statusResultToResponse,
} from "../proto/convert.ts";
import {
  ObserveFrameSchema,
  ObserveRequestSchema,
  ReadRequestSchema,
  ReadResponseSchema,
  ReceiveRequestSchema,
  ReceiveResponseSchema,
  StatusResponseSchema,
} from "../proto/gen/b3nd_pb.ts";
import { ndjsonResponse } from "../../actions/ndjson.ts";
import { runAction } from "../../actions/run.ts";

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
      "Content-Type": enc === "binary"
        ? "application/proto"
        : "application/json",
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
      case "Receive":
        return handleReceive(rig, req, enc);
      case "Read":
        return handleRead(rig, req, enc);
      case "Observe":
        return handleObserve(rig, req);
      case "Status":
        return handleStatus(rig, enc);
      default:
        return Promise.resolve(errResponse(`Unknown method: ${method}`, 404));
    }
  };
}

async function handleReceive(
  rig: Rig,
  req: Request,
  enc: Encoding,
): Promise<Response> {
  let body;
  try {
    body = enc === "binary"
      ? fromBinary(
        ReceiveRequestSchema,
        new Uint8Array(await req.arrayBuffer()),
      )
      : fromJson(ReceiveRequestSchema, await req.json() as JsonValue);
  } catch {
    return errResponse("Invalid request body");
  }
  if (!body.messages?.length) {
    return errResponse("Expected [[uri, payload], ...]");
  }

  const msgs = body.messages.map((m) => outputFromProto(m));
  const results = await runAction(rig, { action: "receive", outputs: msgs });
  const response = create(ReceiveResponseSchema, {
    results: results.map(receiveResultToProto),
  });
  return okResponse(
    enc === "binary"
      ? toBinary(ReceiveResponseSchema, response)
      : JSON.stringify(toJson(ReceiveResponseSchema, response)),
    enc,
  );
}

async function handleRead(
  rig: Rig,
  req: Request,
  enc: Encoding,
): Promise<Response> {
  let body;
  try {
    body = enc === "binary"
      ? fromBinary(ReadRequestSchema, new Uint8Array(await req.arrayBuffer()))
      : fromJson(ReadRequestSchema, await req.json() as JsonValue);
  } catch {
    return errResponse("Invalid request body");
  }
  if (!body.urls?.length) return errResponse("Expected { urls: string[] }");

  try {
    const results = await runAction(rig, {
      action: "read",
      urls: body.urls,
    });
    const response = create(ReadResponseSchema, {
      results: results.map(outputToProto),
    });
    return okResponse(
      enc === "binary"
        ? toBinary(ReadResponseSchema, response)
        : JSON.stringify(toJson(ReadResponseSchema, response)),
      enc,
    );
  } catch (e) {
    return errResponse(e instanceof Error ? e.message : String(e), 500);
  }
}

async function handleObserve(rig: Rig, req: Request): Promise<Response> {
  let body;
  try {
    body = fromJson(ObserveRequestSchema, await req.json() as JsonValue);
  } catch {
    return errResponse("Invalid request body");
  }
  if (!body.urls?.length) return errResponse("Expected { urls: string[] }");

  const abort = new AbortController();
  const onAbort = () => abort.abort();
  req.signal.addEventListener("abort", onAbort, { once: true });

  const frames = runAction(rig, {
    action: "observe",
    urls: body.urls,
    signal: abort.signal,
  });
  return ndjsonResponse(
    frames,
    abort,
    (frame) =>
      toJson(
        ObserveFrameSchema,
        create(ObserveFrameSchema, { uris: [...frame] }),
      ),
  );
}

async function handleStatus(rig: Rig, enc: Encoding): Promise<Response> {
  const result = await runAction(rig, { action: "status" });
  const response = statusResultToResponse(result);
  return okResponse(
    enc === "binary"
      ? toBinary(StatusResponseSchema, response)
      : JSON.stringify(toJson(StatusResponseSchema, response)),
    enc,
  );
}
