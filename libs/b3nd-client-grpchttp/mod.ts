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
 *   import { B3ndService } from "@bandeira-tech/b3nd-servers/grpc/proto";
 *   import { createClient } from "@connectrpc/connect";
 *   import { createConnectTransport } from "@connectrpc/connect-web";
 *   const client = createClient(B3ndService, createConnectTransport({ baseUrl }));
 *
 * @example
 * ```typescript
 * const client = new GrpcHttpClient({ url: "http://localhost:50051" });
 * await client.receive([["mutable://app/item", { name: "thing" }]]);
 * const [result] = await client.read("mutable://app/item");
 * ```
 */

import { create, fromBinary, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import type { JsonValue } from "@bufbuild/protobuf";
import type {
  Message,
  ProtocolInterfaceNode,
  ReadResult,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core";
import {
  messageToReceiveRequest,
  readResultFromProto,
  receiveResponseToResult,
  statusResponseToResult,
} from "../b3nd-proto/convert.ts";
import {
  ObserveRequestSchema,
  ReadRequestSchema,
  ReadResponseSchema,
  ReadResultProtoSchema,
  ReceiveRequestSchema,
  ReceiveResponseSchema,
  StatusRequestSchema,
  StatusResponseSchema,
} from "../b3nd-proto/gen/b3nd_pb.ts";

export interface GrpcHttpClientConfig {
  /** Base URL of the gRPC-HTTP server (e.g. "http://localhost:50051"). */
  url: string;
  /** Use binary protobuf encoding instead of JSON. Default: false. */
  binary?: boolean;
  /** Request timeout in milliseconds. Default: 30000. */
  timeout?: number;
}

const SERVICE_PREFIX = "/b3nd.v1.B3ndService/";

export class GrpcHttpClient implements ProtocolInterfaceNode {
  private baseUrl: string;
  private binary: boolean;
  private timeout: number;
  readonly url: string;

  constructor(config: GrpcHttpClientConfig) {
    this.baseUrl = config.url.replace(/\/$/, "");
    this.url = this.baseUrl;
    this.binary = config.binary ?? false;
    this.timeout = config.timeout ?? 30000;
  }

  private async rpc(method: string, body: BodyInit): Promise<Response> {
    const abort = new AbortController();
    const id = setTimeout(() => abort.abort(), this.timeout);
    try {
      const resp = await fetch(`${this.baseUrl}${SERVICE_PREFIX}${method}`, {
        method: "POST",
        headers: { "Content-Type": this.binary ? "application/proto" : "application/json" },
        body,
        signal: abort.signal,
      });
      if (!resp.ok) {
        throw new Error(`gRPC-HTTP ${method} failed (${resp.status}): ${await resp.text()}`);
      }
      return resp;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error(`gRPC-HTTP ${method} timed out after ${this.timeout}ms`);
      }
      throw e;
    } finally {
      clearTimeout(id);
    }
  }

  async receive(msgs: Message[]): Promise<ReceiveResult[]> {
    return Promise.all(msgs.map(async (msg) => {
      const req = messageToReceiveRequest(msg);
      const body = this.binary
        ? toBinary(ReceiveRequestSchema, req)
        : JSON.stringify(toJson(ReceiveRequestSchema, req));
      const resp = await this.rpc("Receive", body);
      const result = this.binary
        ? fromBinary(ReceiveResponseSchema, new Uint8Array(await resp.arrayBuffer()))
        : fromJson(ReceiveResponseSchema, await resp.json() as JsonValue);
      return receiveResponseToResult(result);
    }));
  }

  async read<T = unknown>(uris: string | string[]): Promise<ReadResult<T>[]> {
    const req = create(ReadRequestSchema, { uris: Array.isArray(uris) ? uris : [uris] });
    const body = this.binary
      ? toBinary(ReadRequestSchema, req)
      : JSON.stringify(toJson(ReadRequestSchema, req));
    const resp = await this.rpc("Read", body);
    const result = this.binary
      ? fromBinary(ReadResponseSchema, new Uint8Array(await resp.arrayBuffer()))
      : fromJson(ReadResponseSchema, await resp.json() as JsonValue);
    return (result.results ?? []).map((r) => readResultFromProto<T>(r));
  }

  async *observe<T = unknown>(
    pattern: string,
    signal: AbortSignal,
  ): AsyncIterable<ReadResult<T>> {
    const abort = new AbortController();
    signal.addEventListener("abort", () => abort.abort());

    const req = create(ObserveRequestSchema, { pattern });
    const resp = await fetch(`${this.baseUrl}${SERVICE_PREFIX}Observe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toJson(ObserveRequestSchema, req)),
      signal: abort.signal,
    });

    if (!resp.ok || !resp.body) return;

    const reader = resp.body.getReader();
    const textDec = new TextDecoder();
    let buffer = "";

    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += textDec.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = JSON.parse(line) as JsonValue;
          if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
            throw new Error(String((parsed as Record<string, unknown>).error));
          }
          yield readResultFromProto<T>(fromJson(ReadResultProtoSchema, parsed));
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async status(): Promise<StatusResult> {
    const req = create(StatusRequestSchema, {});
    const body = this.binary
      ? toBinary(StatusRequestSchema, req)
      : JSON.stringify(toJson(StatusRequestSchema, req));
    const resp = await this.rpc("Status", body);
    const result = this.binary
      ? fromBinary(StatusResponseSchema, new Uint8Array(await resp.arrayBuffer()))
      : fromJson(StatusResponseSchema, await resp.json() as JsonValue);
    return statusResponseToResult(result);
  }
}
