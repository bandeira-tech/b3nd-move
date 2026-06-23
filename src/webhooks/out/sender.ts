/**
 * @module
 * Webhooks **out** — the delivery primitive.
 *
 * A {@link WebhookSender} is the outbound counterpart to the transport
 * *clients* elsewhere in this package: where `HttpClient` pulls results
 * via request/response, a sender *pushes* them to a consumer-registered
 * URL. It signs the body (HMAC-SHA256, same scheme `webhooks/in` verifies
 * — so one B3nd node can deliver straight into another's inbound
 * endpoint), retries transient failures with backoff, and reports the
 * outcome instead of throwing: delivery is best-effort, and the caller
 * (the bridge / subscription loop) decides what a failure means.
 *
 * The `fetch` impl is injectable so the bridge and service tests can
 * assert on what would go on the wire without a live receiver.
 */

import { hmacSha256Hex } from "../hmac.ts";

/** One outbound delivery. Serialized to a JSON body. */
export interface WebhookEvent {
  /** Logical kind — `"observe"` / `"read"` for the bridge's deliveries. */
  type: string;
  /** Arbitrary JSON payload. */
  data: unknown;
  /** Optional delivery id for receiver-side idempotency. */
  id?: string;
}

export interface WebhookSenderConfig {
  /** Destination URL. */
  url: string;
  /** Sign the body with this secret; omit to send unsigned. */
  secret?: string;
  /** Header to carry the signature. Default `"X-B3nd-Signature"`. */
  signatureHeader?: string;
  /** Extra headers merged onto every delivery. */
  headers?: Record<string, string>;
  /** Per-attempt timeout in ms. Default `10000`. */
  timeout?: number;
  /** Extra attempts after the first. Default `3` (so up to 4 total). */
  retries?: number;
  /**
   * Backoff before retry N (1-based), in ms. Default exponential:
   * `min(2^(n-1) * 200, 5000)`.
   */
  backoff?: (attempt: number) => number;
  /** Injectable fetch (tests / custom transport). Default global `fetch`. */
  fetch?: typeof fetch;
  /** Injectable delay (tests). Default `setTimeout`-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** Outcome of a delivery attempt sequence. Never thrown — always returned. */
export interface DeliveryResult {
  /** True iff the receiver answered 2xx. */
  ok: boolean;
  /** Final HTTP status, if a response was produced. */
  status?: number;
  /** Number of attempts made (>= 1). */
  attempts: number;
  /** Failure message when `!ok`. */
  error?: string;
}

/** Push one event to the configured destination. */
export type WebhookSender = (event: WebhookEvent) => Promise<DeliveryResult>;

const defaultBackoff = (attempt: number) =>
  Math.min(2 ** (attempt - 1) * 200, 5000);

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A response status worth retrying — transient server / rate-limit. */
function retriable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Create a sender bound to one destination.
 *
 * Each call serializes `{ type, id?, ts, data }` to JSON, optionally
 * signs it, and POSTs. Network errors, timeouts, 429, and 5xx are
 * retried up to `retries` times with backoff; any other non-2xx is a
 * terminal failure (the receiver rejected the payload — retrying won't
 * help). The returned {@link DeliveryResult} reports the outcome.
 */
export function createWebhookSender(
  config: WebhookSenderConfig,
): WebhookSender {
  const doFetch = config.fetch ?? fetch;
  const sleep = config.sleep ?? defaultSleep;
  const timeout = config.timeout ?? 10000;
  const retries = config.retries ?? 3;
  const backoff = config.backoff ?? defaultBackoff;
  const signatureHeader = config.signatureHeader ?? "X-B3nd-Signature";
  const encoder = new TextEncoder();

  return async (event) => {
    const body = JSON.stringify({
      type: event.type,
      ...(event.id !== undefined ? { id: event.id } : {}),
      ts: Date.now(),
      data: event.data,
    });
    const bytes = encoder.encode(body);

    const baseHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...config.headers,
    };
    if (config.secret) {
      baseHeaders[signatureHeader] = `sha256=${await hmacSha256Hex(
        config.secret,
        bytes,
      )}`;
    }

    let lastError = "";
    let lastStatus: number | undefined;

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      if (attempt > 1) await sleep(backoff(attempt - 1));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await doFetch(config.url, {
          method: "POST",
          headers: baseHeaders,
          body,
          signal: controller.signal,
        });
        lastStatus = res.status;
        // Drain the body so the connection can be reused / closed.
        await res.body?.cancel().catch(() => {});
        if (res.ok) return { ok: true, status: res.status, attempts: attempt };
        lastError = `HTTP ${res.status}`;
        if (!retriable(res.status)) {
          return {
            ok: false,
            status: res.status,
            attempts: attempt,
            error: lastError,
          };
        }
      } catch (e) {
        lastError = e instanceof Error
          ? (e.name === "AbortError" ? `timeout after ${timeout}ms` : e.message)
          : String(e);
      } finally {
        clearTimeout(timer);
      }
    }

    return {
      ok: false,
      status: lastStatus,
      attempts: retries + 1,
      error: lastError,
    };
  };
}
