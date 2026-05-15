/**
 * HttpClient - HTTP implementation of ProtocolInterfaceNode
 *
 * Connects to B3nd HTTP API servers and forwards operations.
 * No schema validation - validation happens server-side.
 */

import type {
  Message,
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { routingKey } from "@bandeira-tech/b3nd-core/url";
import { RequestError, TimeoutError, TransportError } from "../errors.ts";
import { openSseStream } from "./sse.ts";

/** The request about to go on the wire. Mutate any field. */
export interface HttpPreSendRequest {
  url: URL;
  headers: Headers;
  body: BodyInit | null;
}

/**
 * Pre-send hook for HTTP requests. Runs after the default URL,
 * headers, and body are built; mutate the fields in place. Compose
 * multiple behaviors by chaining function calls inside the hook.
 */
export type HttpPreSend = (
  req: HttpPreSendRequest,
) => void | Promise<void>;

/** Configuration for `HttpClient`. */
export interface HttpClientConfig {
  /** Base URL of the HTTP API. */
  url: string;
  /** Optional custom headers. */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds (default: 30000). */
  timeout?: number;
  /**
   * Pre-send hook. Receives the in-flight request; mutate `url`,
   * `headers`, or `body` before it leaves. Use this for auth, tracing,
   * signing, etc.
   *
   * @example
   * ```ts
   * new HttpClient({
   *   url,
   *   preSend: (r) => r.headers.set("Authorization", `Bearer ${getToken()}`),
   * });
   * ```
   */
  preSend?: HttpPreSend;
}

export class HttpClient implements ProtocolInterfaceNode {
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeout: number;
  private preSend: HttpPreSend | undefined;

  /** The base URL this client connects to. */
  readonly url: string;

  constructor(config: HttpClientConfig) {
    this.baseUrl = config.url.replace(/\/$/, ""); // Remove trailing slash
    this.url = this.baseUrl;
    this.headers = config.headers || {};
    this.timeout = config.timeout || 30000;
    this.preSend = config.preSend;
  }

  /**
   * Make an HTTP request with timeout. Wraps network/abort failures in
   * `TransportError` / `TimeoutError` so callers can branch on cause.
   */
  private async request(
    path: string,
    options: RequestInit = {},
    operation?: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const req: HttpPreSendRequest = {
        url: new URL(`${this.baseUrl}${path}`),
        headers: new Headers({
          "Content-Type": "application/json",
          ...this.headers,
          ...(options.headers as Record<string, string> | undefined),
        }),
        body: (options.body ?? null) as BodyInit | null,
      };

      if (this.preSend) await this.preSend(req);

      const response = await fetch(req.url, {
        ...options,
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
      });

      return response;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new TimeoutError("http", this.timeout, operation, {
          cause: error,
        });
      }
      throw new TransportError(
        "http",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Receive a batch of messages (unified interface)
   * POSTs to /api/v1/receive endpoint
   * @param msgs - Array of Message tuples [uri, payload]
   * @returns ReceiveResult[] — one result per message
   */
  async receive(msgs: Message[]): Promise<ReceiveResult[]> {
    // Pre-validate URIs — return error results for invalid ones without sending
    const results: (ReceiveResult | null)[] = msgs.map(([uri]) => {
      if (!uri || typeof uri !== "string") {
        return { accepted: false, error: "Message URI is required" };
      }
      return null; // valid, will be sent
    });

    const validIndices: number[] = [];
    const validMsgs: Message[] = [];
    for (let i = 0; i < msgs.length; i++) {
      if (results[i] === null) {
        validIndices.push(i);
        validMsgs.push(msgs[i]);
      }
    }

    // If no valid messages, return the error results
    if (validMsgs.length === 0) {
      return results as ReceiveResult[];
    }

    try {
      const serializedBatch = JSON.stringify(validMsgs);

      const response = await this.request("/api/v1/receive", {
        method: "POST",
        body: serializedBatch,
      }, "receive");

      if (!response.ok) {
        // Request-level failure (bad JSON, malformed batch, server error).
        // Per-slot results require a 2xx body — fan the status out across
        // every valid slot.
        const errorMsg = `HTTP ${response.status} ${response.statusText}`
          .trim();
        for (const idx of validIndices) {
          results[idx] = { accepted: false, error: errorMsg };
        }
      } else {
        // 2xx: server processed the batch; trust the per-slot body.
        const serverResults: ReceiveResult[] = await response.json();
        for (let j = 0; j < validIndices.length; j++) {
          results[validIndices[j]] = serverResults[j] ?? {
            accepted: false,
            error: "No result from server",
          };
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      for (const idx of validIndices) {
        results[idx] = { accepted: false, error: errorMsg };
      }
    }

    return results as ReceiveResult[];
  }

  async read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
    if (urls.length === 0) return [];
    const response = await this.request("/api/v1/read", {
      method: "POST",
      body: JSON.stringify({ urls }),
    }, "read");
    if (!response.ok) {
      const body = await response.text();
      throw new RequestError(
        "http",
        `read failed: HTTP ${response.status} ${response.statusText}${
          body ? `: ${body}` : ""
        }`,
        {
          status: response.status,
          body,
          operation: "read",
        },
      );
    }
    // Payloads pass through as JSON-parsed values. Content semantics
    // (miss representation, binary encoding, etc.) are the caller's
    // concern — opt in via content codecs like
    // `@bandeira-tech/b3nd-canon/binary` if you need them.
    return await response.json() as Output<T>[];
  }

  async *observe(
    urls: string[],
    signal: AbortSignal,
  ): AsyncIterable<Output<string[]>> {
    if (urls.length === 0) return;

    // Open one SSE stream per url's routing key. The query string is
    // ignored — observe is INV-style and only the uri pattern matters.
    const queue: Output<string[]>[] = [];
    let wake: (() => void) | null = null;

    const forwarders = urls.map(async (url) => {
      const pattern = routingKey(url);
      // "mutable://data/market/*" → "mutable://data/market"
      const segments = pattern.split("/");
      const prefix = segments
        .filter((s) => !s.startsWith(":") && s !== "*")
        .join("/");
      const uriPath = prefix.replace("://", "/");
      const req: HttpPreSendRequest = {
        url: new URL(`${this.baseUrl}/api/v1/observe/${uriPath}`),
        headers: new Headers(this.headers),
        body: null,
      };
      // Observe is a long-lived GET; run preSend once so auth-style
      // hooks can stamp headers / query params onto the request.
      if (this.preSend) await this.preSend(req);
      try {
        for await (
          const event of openSseStream(req.url.toString(), {
            signal,
            headers: req.headers,
          })
        ) {
          if (signal.aborted) return;
          // Each SSE event carries one uri (or several, when the
          // server batches). Tag the package with the caller's input
          // url so consumers can route per subscription.
          const uris = Array.isArray(event.uris)
            ? (event.uris as string[])
            : typeof event.uri === "string"
            ? [event.uri]
            : [];
          if (uris.length === 0) continue;
          queue.push([url, uris]);
          const w = wake;
          if (w) {
            wake = null;
            w();
          }
        }
      } catch {
        // Per-stream errors are swallowed — one broken peer should
        // not tear down the merged stream.
      }
    });

    const onAbort = () => {
      const w = wake;
      if (w) {
        wake = null;
        w();
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      while (true) {
        while (queue.length > 0) yield queue.shift()!;
        if (signal.aborted) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      await Promise.allSettled(forwarders);
    }
  }

  async status(): Promise<StatusResult> {
    try {
      const response = await this.request("/api/v1/health", {
        method: "GET",
      }, "status");

      if (!response.ok) {
        return {
          status: "unhealthy",
          message: "Health check failed",
        };
      }

      const healthResult = await response.json();
      const status: StatusResult = {
        status: healthResult.status ?? "healthy",
        message: healthResult.message,
        details: healthResult.details,
      };
      if (Array.isArray(healthResult.fns)) status.fns = healthResult.fns;

      // Try to fetch schema info
      try {
        const schemaResponse = await this.request("/api/v1/schema", {
          method: "GET",
        }, "schema");
        if (schemaResponse.ok) {
          const schemaResult = await schemaResponse.json();
          if (schemaResult.schema && Array.isArray(schemaResult.schema)) {
            status.schema = schemaResult.schema;
          }
        }
      } catch {
        // Schema endpoint optional — ignore errors
      }

      return status;
    } catch (error) {
      return {
        status: "unhealthy",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
