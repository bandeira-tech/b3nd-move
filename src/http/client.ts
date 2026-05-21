/**
 * HttpClient — HTTP implementation of ProtocolInterfaceNode.
 *
 * Speaks the wire shape served by `httpApi` in `service.ts`. The URL
 * list rides in the query as `?u=<b64>` (see
 * `../codecs/url-list.ts`) so routing / auth / observability can
 * decide on a request without parsing the body. The receive body is
 * opaque: `application/octet-stream` carrying the same `bytes-list`
 * framing at `lenSize: 4` (see `../codecs/bytes-list.ts`) — the move
 * layer never JSON-parses payloads.
 *
 *   GET  /api/v1/status            — status (sole status endpoint)
 *   POST /api/v1/receive?u=<b64>   — body: framed payload bytes
 *   POST /api/v1/read?u=<b64>      — no body
 *   POST /api/v1/observe?u=<b64>   — no body, NDJSON response of frames
 *
 * `receive` payloads must be `Uint8Array` — the producing app
 * encodes once at its own boundary using whatever schema it shares
 * with the consumer. No schema validation happens here; only at the
 * edges where the schema is known.
 */

import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { RequestError, TimeoutError, TransportError } from "../errors.ts";
import { encodeBytesList } from "../codecs/bytes-list.ts";
import { encodeUrlList } from "../codecs/url-list.ts";

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
   * (`observe`) so auth-style hooks fire once per connection. The
   * caller passes an already-prepared `body` (or `null` for no body)
   * plus the `Content-Type` to advertise; no auto-serialization
   * happens here.
   */
  private async prepare(
    path: string,
    body: BodyInit | null = null,
    contentType?: string,
  ): Promise<{ url: URL; headers: Headers; body: BodyInit | null }> {
    const headers = new Headers({ ...this.headers });
    if (body !== null && contentType) {
      headers.set("Content-Type", contentType);
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
    init: { method: string; body?: BodyInit | null; contentType?: string },
    operation?: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const { url, headers, body } = await this.prepare(
        path,
        init.body ?? null,
        init.contentType,
      );
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
   * Payloads must be `Uint8Array` — the move layer is opaque past
   * the URL. Non-bytes payloads are rejected per-slot with an error
   * result without sending the request. The producing app is the
   * only place that has the schema, so it's the only place that
   * encodes.
   *
   * @param msgs Array of `Output` tuples `[url, Uint8Array]`.
   * @returns One `ReceiveResult` per input output, in input order.
   */
  async receive(msgs: Output[]): Promise<ReceiveResult[]> {
    // Pre-validate URLs and payload shape — return per-slot error results
    // for invalid entries without sending.
    const results: (ReceiveResult | null)[] = msgs.map(([url, payload]) => {
      if (!url || typeof url !== "string") {
        return { accepted: false, error: "Output URL is required" };
      }
      if (!(payload instanceof Uint8Array)) {
        return {
          accepted: false,
          error: "Payload must be Uint8Array",
        };
      }
      return null;
    });

    const validIndices: number[] = [];
    const validUrls: string[] = [];
    const validPayloads: Uint8Array[] = [];
    for (let i = 0; i < msgs.length; i++) {
      if (results[i] === null) {
        validIndices.push(i);
        validUrls.push(msgs[i][0]);
        validPayloads.push(msgs[i][1] as Uint8Array);
      }
    }
    if (validUrls.length === 0) return results as ReceiveResult[];

    try {
      const u = encodeUrlList(validUrls);
      // Cast around lib.dom's `BodyInit` insisting on `ArrayBuffer`
      // (not `ArrayBufferLike`) for typed-array bodies. `fetch`
      // accepts the Uint8Array fine at runtime.
      const body = encodeBytesList(
        validPayloads,
        { lenSize: 4 },
      ) as unknown as BodyInit;
      const response = await this.request(`/api/v1/receive?u=${u}`, {
        method: "POST",
        body,
        contentType: "application/octet-stream",
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
    const u = encodeUrlList(urls);
    const response = await this.request(`/api/v1/read?u=${u}`, {
      method: "POST",
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
  ): AsyncIterable<readonly string[]> {
    if (urls.length === 0) return;

    const u = encodeUrlList(urls);
    const { url, headers, body } = await this.prepare(
      `/api/v1/observe?u=${u}`,
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
          // Frame shape: `string[]` — batch of uris that fired.
          // Anything else (e.g. an error envelope `{ error }`) is
          // skipped — observe yields only well-formed frames.
          if (
            Array.isArray(parsed) &&
            parsed.every((u) => typeof u === "string")
          ) {
            yield parsed as readonly string[];
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
