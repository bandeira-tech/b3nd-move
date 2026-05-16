/**
 * HttpClient — HTTP implementation of ProtocolInterfaceNode.
 *
 * Speaks the wire shape served by `httpApi` in `service.ts`:
 *
 *   GET  /api/v1/status     — status (sole status endpoint)
 *   POST /api/v1/receive    — body: [[uri, payload], ...]
 *   POST /api/v1/read       — body: string[]
 *   POST /api/v1/observe    — body: string[] → NDJSON stream of frames
 *
 * No schema validation — validation happens server-side.
 */

import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { RequestError, TimeoutError, TransportError } from "../errors.ts";

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
   * Build the in-flight request and run the preSend hook.
   *
   * Used by both unary `request()` and long-lived streaming requests
   * (`observe`) so auth-style hooks fire once per connection.
   */
  private async prepare(
    path: string,
    bodyJson?: unknown,
  ): Promise<{ url: URL; headers: Headers; body: BodyInit | null }> {
    const headers = new Headers({ ...this.headers });
    let body: BodyInit | null = null;
    if (bodyJson !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(bodyJson);
    }
    const req: HttpPreSendRequest = {
      url: new URL(`${this.baseUrl}${path}`),
      headers,
      body,
    };
    if (this.preSend) await this.preSend(req);
    return { url: req.url, headers: req.headers, body: req.body };
  }

  /**
   * Unary request with timeout. Wraps network/abort failures in
   * `TransportError` / `TimeoutError` so callers can branch on cause.
   */
  private async request(
    path: string,
    init: { method: string; body?: unknown },
    operation?: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const { url, headers, body } = await this.prepare(path, init.body);
      const response = await fetch(url, {
        method: init.method,
        headers,
        body,
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
   * Receive a batch of outputs.
   *
   * @param msgs Array of `Output` tuples `[uri, payload]`.
   * @returns One `ReceiveResult` per input output, in input order.
   */
  async receive(msgs: Output[]): Promise<ReceiveResult[]> {
    // Pre-validate URIs — return error results for invalid ones without sending
    const results: (ReceiveResult | null)[] = msgs.map(([uri]) => {
      if (!uri || typeof uri !== "string") {
        return { accepted: false, error: "Output URI is required" };
      }
      return null;
    });

    const validIndices: number[] = [];
    const validMsgs: Output[] = [];
    for (let i = 0; i < msgs.length; i++) {
      if (results[i] === null) {
        validIndices.push(i);
        validMsgs.push(msgs[i]);
      }
    }
    if (validMsgs.length === 0) return results as ReceiveResult[];

    try {
      const response = await this.request("/api/v1/receive", {
        method: "POST",
        body: validMsgs,
      }, "receive");

      if (!response.ok) {
        const errorMsg = `HTTP ${response.status} ${response.statusText}`
          .trim();
        for (const idx of validIndices) {
          results[idx] = { accepted: false, error: errorMsg };
        }
      } else {
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
      body: urls,
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
    return await response.json() as Output<T>[];
  }

  async *observe(
    urls: string[],
    signal: AbortSignal,
  ): AsyncIterable<Output<string[]>> {
    if (urls.length === 0) return;

    const { url, headers, body } = await this.prepare(
      "/api/v1/observe",
      urls,
    );

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal,
      });
    } catch (err) {
      if (signal.aborted) return;
      throw new TransportError(
        "http",
        err instanceof Error ? err.message : String(err),
        { cause: err },
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new RequestError(
        "http",
        `observe failed: HTTP ${response.status} ${response.statusText}${
          text ? `: ${text}` : ""
        }`,
        { status: response.status, body: text, operation: "observe" },
      );
    }
    if (!response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const onAbort = () => {
      reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });

    let buffer = "";
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          // Frame shape: `[pattern, uris[]]`. Anything else (e.g. an
          // error envelope `{ error }`) is skipped — observe yields
          // only well-formed frames.
          if (
            Array.isArray(parsed) && parsed.length === 2 &&
            typeof parsed[0] === "string" && Array.isArray(parsed[1])
          ) {
            yield parsed as Output<string[]>;
          }
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }
  }

  async status(): Promise<StatusResult> {
    try {
      const response = await this.request("/api/v1/status", {
        method: "GET",
      }, "status");

      if (!response.ok) {
        return {
          status: "unhealthy",
          message: `status check failed: HTTP ${response.status}`,
        };
      }
      return await response.json() as StatusResult;
    } catch (error) {
      return {
        status: "unhealthy",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
