/**
 * @module
 * gRPC-HTTP client — ProtocolInterfaceNode over grpcHttpApi.
 *
 * Works in any fetch-capable environment: browsers, Deno, Bun, Node 18+.
 * Encoding is configurable:
 *   binary: false (default) → application/json, human-readable, devtools-friendly
 *   binary: true            → application/proto, compact wire format
 *
 * Observe always uses NDJSON regardless of `binary` — connect it to the same
 * grpcHttpApi server on any runtime.
 *
 * Web apps that prefer the connectrpc ecosystem can also use the generated
 * B3ndService descriptor with @connectrpc/connect-web for unary methods:
 *   import { B3ndService } from "@bandeira-tech/b3nd-move/grpc/proto";
 *   import { createClient } from "@connectrpc/connect";
 *   import { createConnectTransport } from "@connectrpc/connect-web";
 *   const client = createClient(B3ndService, createConnectTransport({ baseUrl }));
 *
 * @example
 * ```typescript
 * import { grpcProto } from "@bandeira-tech/b3nd-move/codecs/grpc";
 * const client = new GrpcHttpClient({ url: "http://localhost:50051", codec: grpcProto() });
 * await client.receive([["mutable://app/item", { name: "thing" }]]);
 * const [out] = await client.read(["mutable://app/item"]);
 * const [uri, payload] = out;
 * ```
 */

import {
  create,
  fromBinary,
  fromJson,
  toBinary,
  toJson,
} from "@bufbuild/protobuf";
import type { JsonValue } from "@bufbuild/protobuf";
import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core";
import {
  EncodingError,
  RequestError,
  TimeoutError,
  TransportError,
} from "../../errors.ts";
import { statusResponseToResult } from "../proto/convert.ts";
import type { GrpcBatchCodec } from "./codec.ts";
import {
  ObserveFrameSchema,
  ObserveRequestSchema,
  ReadRequestSchema,
  ReadResponseSchema,
  ReceiveRequestSchema,
  ReceiveResponseSchema,
  StatusRequestSchema,
  StatusResponseSchema,
} from "../proto/gen/b3nd_pb.ts";

/** The request about to go on the wire. Mutate any field. */
export interface GrpcHttpPreSendRequest {
  url: URL;
  headers: Headers;
  body: BodyInit | null;
}

/**
 * Pre-send hook for gRPC-HTTP requests. Runs after the default URL,
 * headers, and body are built; mutate the fields in place.
 */
export type GrpcHttpPreSend = (
  req: GrpcHttpPreSendRequest,
) => void | Promise<void>;

export interface GrpcHttpClientConfig {
  /** Base URL of the gRPC-HTTP server (e.g. "http://localhost:50051"). */
  url: string;
  /** Codec for read/receive proto message construction. Required. */
  codec: GrpcBatchCodec;
  /** Use binary protobuf encoding instead of JSON. Default: false. */
  binary?: boolean;
  /** Request timeout in milliseconds. Default: 30000. */
  timeout?: number;
  /**
   * Pre-send hook. Receives the in-flight request; mutate `url`,
   * `headers`, or `body` before it leaves. Use this for auth, tracing,
   * signing, etc.
   */
  preSend?: GrpcHttpPreSend;
}

const SERVICE_PREFIX = "/b3nd.v1.B3ndService/";

export class GrpcHttpClient implements ProtocolInterfaceNode {
  private baseUrl: string;
  private codec: GrpcBatchCodec;
  private binary: boolean;
  private timeout: number;
  private preSend: GrpcHttpPreSend | undefined;
  readonly url: string;

  constructor(config: GrpcHttpClientConfig) {
    this.baseUrl = config.url.replace(/\/$/, "");
    this.url = this.baseUrl;
    this.codec = config.codec;
    this.binary = config.binary ?? false;
    this.timeout = config.timeout ?? 30000;
    this.preSend = config.preSend;
  }

  private async rpc(method: string, body: BodyInit): Promise<Response> {
    const abort = new AbortController();
    const id = setTimeout(() => abort.abort(), this.timeout);
    try {
      const req: GrpcHttpPreSendRequest = {
        url: new URL(`${this.baseUrl}${SERVICE_PREFIX}${method}`),
        headers: new Headers({
          "Content-Type": this.binary
            ? "application/proto"
            : "application/json",
        }),
        body,
      };
      if (this.preSend) await this.preSend(req);
      const resp = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: abort.signal,
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new RequestError(
          "grpc-http",
          `${method} failed: HTTP ${resp.status}${text ? `: ${text}` : ""}`,
          { status: resp.status, body: text, operation: method },
        );
      }
      return resp;
    } catch (e) {
      // Already typed — propagate unchanged.
      if (e instanceof RequestError) throw e;
      if (e instanceof Error && e.name === "AbortError") {
        throw new TimeoutError("grpc-http", this.timeout, method, {
          cause: e,
        });
      }
      throw new TransportError(
        "grpc-http",
        e instanceof Error ? e.message : String(e),
        { cause: e },
      );
    } finally {
      clearTimeout(id);
    }
  }

  async receive(msgs: Output[]): Promise<ReceiveResult[]> {
    if (msgs.length === 0) return [];
    const req = this.codec.encodeReceiveRequest(msgs);
    const body = this.binary
      ? toBinary(ReceiveRequestSchema, req)
      : JSON.stringify(toJson(ReceiveRequestSchema, req));
    const resp = await this.rpc("Receive", body);
    const result = this.binary
      ? fromBinary(
        ReceiveResponseSchema,
        new Uint8Array(await resp.arrayBuffer()),
      )
      : fromJson(ReceiveResponseSchema, await resp.json() as JsonValue);
    return this.codec.decodeReceiveResponse(result);
  }

  async read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
    if (urls.length === 0) return [];
    const req = this.codec.encodeReadRequest(urls);
    const body = this.binary
      ? toBinary(ReadRequestSchema, req)
      : JSON.stringify(toJson(ReadRequestSchema, req));
    const resp = await this.rpc("Read", body);
    const result = this.binary
      ? fromBinary(ReadResponseSchema, new Uint8Array(await resp.arrayBuffer()))
      : fromJson(ReadResponseSchema, await resp.json() as JsonValue);
    return this.codec.decodeReadResponse(result) as Output<T>[];
  }

  async *observe(
    urls: string[],
    signal: AbortSignal,
  ): AsyncIterable<readonly string[]> {
    if (urls.length === 0) return;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) abort.abort();

    let resp: Response;
    try {
      const obsReq = create(ObserveRequestSchema, { urls });
      const req: GrpcHttpPreSendRequest = {
        url: new URL(`${this.baseUrl}${SERVICE_PREFIX}Observe`),
        headers: new Headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(toJson(ObserveRequestSchema, obsReq)),
      };
      if (this.preSend) await this.preSend(req);
      resp = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: abort.signal,
      });
    } catch (e) {
      signal.removeEventListener("abort", onAbort);
      // Caller-initiated abort exits the iterator cleanly; anything else
      // propagates.
      if (signal.aborted) return;
      throw new TransportError(
        "grpc-http",
        e instanceof Error ? e.message : String(e),
        { cause: e },
      );
    }

    if (!resp.ok || !resp.body) {
      signal.removeEventListener("abort", onAbort);
      return;
    }

    const reader = resp.body.getReader();
    const textDec = new TextDecoder();
    let buffer = "";

    try {
      while (!signal.aborted) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (signal.aborted) return;
          throw new TransportError(
            "grpc-http",
            e instanceof Error ? e.message : String(e),
            { cause: e },
          );
        }
        const { done, value } = chunk;
        if (done) break;
        buffer += textDec.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed: JsonValue;
          try {
            parsed = JSON.parse(line) as JsonValue;
          } catch (e) {
            throw new EncodingError(
              "grpc-http",
              `failed to parse observe frame: ${
                e instanceof Error ? e.message : String(e)
              }`,
              { cause: e },
            );
          }
          if (
            typeof parsed === "object" && parsed !== null && "error" in parsed
          ) {
            const err = String((parsed as Record<string, unknown>).error);
            throw new RequestError("grpc-http", err, {
              body: err,
              operation: "Observe",
            });
          }
          const frame = fromJson(ObserveFrameSchema, parsed);
          yield frame.uris;
        }
      }
    } finally {
      reader.releaseLock();
      signal.removeEventListener("abort", onAbort);
    }
  }

  async status(): Promise<StatusResult> {
    const req = create(StatusRequestSchema, {});
    const body = this.binary
      ? toBinary(StatusRequestSchema, req)
      : JSON.stringify(toJson(StatusRequestSchema, req));
    const resp = await this.rpc("Status", body);
    const result = this.binary
      ? fromBinary(
        StatusResponseSchema,
        new Uint8Array(await resp.arrayBuffer()),
      )
      : fromJson(StatusResponseSchema, await resp.json() as JsonValue);
    return statusResponseToResult(result);
  }
}
