/**
 * @module
 * gRPC client — ProtocolInterfaceNode over the Connect protocol.
 *
 * Mirrors HttpClient but speaks to `B3ndService` RPC endpoints
 * instead of REST. Uses JSON over HTTP/2 (Connect protocol).
 *
 * @example
 * ```typescript
 * const client = new GrpcClient({ url: "http://localhost:50051" });
 * const results = await client.read("mutable://app/data");
 * ```
 */

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
import type {
  ReadResponse,
  ReceiveResponse,
  StatusResponse,
} from "../b3nd-proto/schema.ts";

export interface GrpcClientConfig {
  /** Base URL of the gRPC server (e.g. "http://localhost:50051"). */
  url: string;
  /** Request timeout in milliseconds. Default: 30000. */
  timeout?: number;
}

const SERVICE_PREFIX = "/b3nd.v1.B3ndService/";

export class GrpcClient implements ProtocolInterfaceNode {
  private baseUrl: string;
  private timeout: number;

  /** The base URL this client connects to. */
  readonly url: string;

  constructor(config: GrpcClientConfig) {
    this.baseUrl = config.url.replace(/\/$/, "");
    this.url = this.baseUrl;
    this.timeout = config.timeout ?? 30000;
  }

  private async rpc<T>(method: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(
        `${this.baseUrl}${SERVICE_PREFIX}${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`gRPC ${method} failed (${response.status}): ${text}`);
      }

      return await response.json() as T;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`gRPC ${method} timeout after ${this.timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async receive(msgs: Message[]): Promise<ReceiveResult[]> {
    const results: ReceiveResult[] = [];
    for (const msg of msgs) {
      const req = messageToReceiveRequest(msg);
      // Encode Uint8Array data as base64 for JSON transport
      const body = {
        ...req,
        data: req.data instanceof Uint8Array
          ? bytesToBase64(req.data)
          : req.data,
      };
      const response = await this.rpc<ReceiveResponse>("Receive", body);
      results.push(receiveResponseToResult(response));
    }
    return results;
  }

  async read<T = unknown>(uris: string | string[]): Promise<ReadResult<T>[]> {
    const uriList = Array.isArray(uris) ? uris : [uris];
    const response = await this.rpc<ReadResponse>("Read", { uris: uriList });
    return (response.results ?? []).map((r) => {
      // Decode base64 data from JSON transport
      if (r.record?.data && typeof r.record.data === "string") {
        (r.record as unknown as Record<string, unknown>).data = base64ToBytes(
          r.record.data as unknown as string,
        );
      }
      return readResultFromProto<T>(r);
    });
  }

  async *observe<T = unknown>(
    pattern: string,
    signal: AbortSignal,
  ): AsyncIterable<ReadResult<T>> {
    const controller = new AbortController();
    signal.addEventListener("abort", () => controller.abort());

    const response = await fetch(
      `${this.baseUrl}${SERVICE_PREFIX}Observe`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern }),
        signal: controller.signal,
      },
    );

    if (!response.ok || !response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const proto = JSON.parse(line);
          if (proto.error) {
            throw new Error(proto.error);
          }
          // Decode base64 data
          if (proto.record?.data && typeof proto.record.data === "string") {
            proto.record.data = base64ToBytes(proto.record.data);
          }
          yield readResultFromProto<T>(proto);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async status(): Promise<StatusResult> {
    const response = await this.rpc<StatusResponse>("Status", {});
    return statusResponseToResult(response);
  }
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
