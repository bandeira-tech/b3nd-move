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
 * const client = new GrpcHttpClient({ url: "http://localhost:50051" });
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
  Message,
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core";
import {
  outputFromProto,
  outputToProto,
  receiveResultFromProto,
  statusResponseToResult,
} from "../proto/convert.ts";
import { type ClientMiddleware, runRequest } from "../../middleware.ts";
import {
  ObserveRequestSchema,
  OutputProtoSchema,
  ReadRequestSchema,
  ReadResponseSchema,
  ReceiveRequestSchema,
  ReceiveResponseSchema,
  StatusRequestSchema,
  StatusResponseSchema,
} from "../proto/gen/b3nd_pb.ts";

export interface GrpcHttpClientConfig {
  /** Base URL of the gRPC-HTTP server (e.g. "http://localhost:50051"). */
  url: string;
  /** Use binary protobuf encoding instead of JSON. Default: false. */
  binary?: boolean;
  /** Request timeout in milliseconds. Default: 30000. */
  timeout?: number;
  /**
   * Composable middleware run before every outbound request. See
   * `b3nd-move/middleware` for canon helpers like `bearer()` / `basic()`.
   */
  middleware?: ClientMiddleware[];
}

const SERVICE_PREFIX = "/b3nd.v1.B3ndService/";

export class GrpcHttpClient implements ProtocolInterfaceNode {
  private baseUrl: string;
  private binary: boolean;
  private timeout: number;
  private middleware: ClientMiddleware[] | undefined;
  readonly url: string;

  constructor(config: GrpcHttpClientConfig) {
    this.baseUrl = config.url.replace(/\/$/, "");
    this.url = this.baseUrl;
    this.binary = config.binary ?? false;
    this.timeout = config.timeout ?? 30000;
    this.middleware = config.middleware;
  }

  private async rpc(method: string, body: BodyInit): Promise<Response> {
    const abort = new AbortController();
    const id = setTimeout(() => abort.abort(), this.timeout);
    try {
      const url = new URL(`${this.baseUrl}${SERVICE_PREFIX}${method}`);
      const headers = new Headers({
        "Content-Type": this.binary
          ? "application/proto"
          : "application/json",
      });
      const ctx = {
        transport: "grpc-http" as const,
        url,
        headers,
        body: body as BodyInit | null,
      };
      await runRequest(this.middleware, ctx);
      const resp = await fetch(ctx.url, {
        method: "POST",
        headers: ctx.headers,
        body: ctx.body,
        signal: abort.signal,
      });
      if (!resp.ok) {
        throw new Error(
          `gRPC-HTTP ${method} failed (${resp.status}): ${await resp.text()}`,
        );
      }
      return resp;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error(
          `gRPC-HTTP ${method} timed out after ${this.timeout}ms`,
        );
      }
      throw e;
    } finally {
      clearTimeout(id);
    }
  }

  async receive(msgs: Message[]): Promise<ReceiveResult[]> {
    if (msgs.length === 0) return [];
    const req = create(ReceiveRequestSchema, {
      messages: msgs.map((m) => outputToProto(m)),
    });
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
    return (result.results ?? []).map(receiveResultFromProto);
  }

  async read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
    if (urls.length === 0) return [];
    const req = create(ReadRequestSchema, { urls });
    const body = this.binary
      ? toBinary(ReadRequestSchema, req)
      : JSON.stringify(toJson(ReadRequestSchema, req));
    const resp = await this.rpc("Read", body);
    const result = this.binary
      ? fromBinary(ReadResponseSchema, new Uint8Array(await resp.arrayBuffer()))
      : fromJson(ReadResponseSchema, await resp.json() as JsonValue);
    return (result.results ?? []).map((r) => outputFromProto<T>(r));
  }

  async *observe(
    urls: string[],
    signal: AbortSignal,
  ): AsyncIterable<Output<string[]>> {
    if (urls.length === 0) return;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) abort.abort();

    let resp: Response;
    try {
      const req = create(ObserveRequestSchema, { urls });
      const ctx = {
        transport: "grpc-http" as const,
        url: new URL(`${this.baseUrl}${SERVICE_PREFIX}Observe`),
        headers: new Headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(toJson(ObserveRequestSchema, req)) as
          | BodyInit
          | null,
      };
      await runRequest(this.middleware, ctx);
      resp = await fetch(ctx.url, {
        method: "POST",
        headers: ctx.headers,
        body: ctx.body,
        signal: abort.signal,
      });
    } catch (e) {
      signal.removeEventListener("abort", onAbort);
      // Caller-initiated abort exits the iterator cleanly; anything else
      // propagates.
      if (signal.aborted) return;
      throw e;
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
          throw e;
        }
        const { done, value } = chunk;
        if (done) break;
        buffer += textDec.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = JSON.parse(line) as JsonValue;
          if (
            typeof parsed === "object" && parsed !== null && "error" in parsed
          ) {
            throw new Error(String((parsed as Record<string, unknown>).error));
          }
          yield outputFromProto<string[]>(fromJson(OutputProtoSchema, parsed));
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
