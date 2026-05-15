/**
 * @module
 * Typed errors for the move layer.
 *
 * Every transport client throws one of these so callers can branch on
 * cause without parsing message strings:
 *
 *   - `TransportError` — network/connection-level failure (DNS, refused,
 *     socket closed, fetch threw, …). The request never produced a
 *     server-shaped response.
 *   - `TimeoutError` — request was aborted because it exceeded the
 *     configured timeout. Subclass of `TransportError`.
 *   - `RequestError` — the wire round-trip succeeded but the server
 *     returned a non-success response (HTTP 4xx/5xx, gRPC error frame,
 *     WS `success: false` envelope). Carries `status` + raw `body` when
 *     the transport exposes them.
 *   - `EncodingError` — request body could not be encoded, or the
 *     response could not be decoded (bad JSON, protobuf parse failure).
 *
 * The hierarchy is intentionally flat — one base class (`MoveError`) so
 * code that just wants "did this come from the move layer?" can do a
 * single `instanceof` check, plus narrow leaf classes for everything
 * else.
 */

/** Base class for every error thrown by the move layer. */
export abstract class MoveError extends Error {
  /** Discriminant tag — pairs with `name` for non-`instanceof` callers. */
  abstract readonly kind: "transport" | "timeout" | "request" | "encoding";
  /** Which transport produced the error (`http`, `ws`, `grpc-http`, `sse`). */
  readonly transport: string;

  constructor(transport: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.transport = transport;
  }
}

/** Network/connection-level failure — no server-shaped response was produced. */
export class TransportError extends MoveError {
  readonly kind = "transport" as const;
}

/**
 * Request was aborted after exceeding the configured timeout.
 *
 * Sits alongside `TransportError` rather than below it — both indicate
 * "no server-shaped response was produced", but timeouts are surfaced
 * with their own type so callers can react (retry, surface to user,
 * widen the budget) without parsing a message. `instanceof MoveError`
 * catches both; explicit `instanceof TimeoutError` distinguishes them.
 */
export class TimeoutError extends MoveError {
  readonly kind = "timeout" as const;
  /** Timeout budget that was exceeded, in milliseconds. */
  readonly timeoutMs: number;

  constructor(
    transport: string,
    timeoutMs: number,
    operation?: string,
    options?: ErrorOptions,
  ) {
    super(
      transport,
      `${operation ?? "request"} timed out after ${timeoutMs}ms`,
      options,
    );
    this.timeoutMs = timeoutMs;
  }
}

/** Server returned a non-success response — round-trip succeeded, request failed. */
export class RequestError extends MoveError {
  readonly kind = "request" as const;
  /** Numeric status (HTTP status, or undefined for WS/gRPC-stream errors). */
  readonly status?: number;
  /** Raw response body (or server-provided error string), when available. */
  readonly body?: string;
  /** Operation name (`receive`, `read`, `observe`, `status`, …). */
  readonly operation?: string;

  constructor(
    transport: string,
    message: string,
    init: {
      status?: number;
      body?: string;
      operation?: string;
      cause?: unknown;
    } = {},
  ) {
    super(transport, message, init.cause ? { cause: init.cause } : undefined);
    this.status = init.status;
    this.body = init.body;
    this.operation = init.operation;
  }
}

/** Encoding/decoding failure — bad JSON, protobuf parse, etc. */
export class EncodingError extends MoveError {
  readonly kind = "encoding" as const;

  constructor(transport: string, message: string, options?: ErrorOptions) {
    super(transport, message, options);
  }
}
