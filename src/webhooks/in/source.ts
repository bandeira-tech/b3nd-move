/**
 * @module
 * The inbound-webhook contract — a {@link WebhookSource} — plus the
 * composable helpers that build the two hooks it needs.
 *
 * A *source* is one external sender (GitHub, Stripe, a partner system,
 * another B3nd node) that POSTs delivery requests to us. Each source
 * declares two host-supplied hooks:
 *
 *   verify  authenticate the delivery — throw {@link Unauthorized} to
 *           reject. Optional; omit for an open endpoint behind other auth.
 *   decode  map the verified delivery → `Output[]` for `rig.receive`.
 *           Throw {@link BadRequest} on a malformed payload.
 *
 * This is the webhooks analogue of `http-post-content`'s `payloadDecoder`:
 * one hook turns an opaque request into rig inputs. It carries more than
 * the POST facet because webhooks add authenticity (signatures) and
 * fan-out (one delivery can map to many outputs — a batched event push).
 *
 * The split — types here, helpers in the same file (small surface) — and
 * the "primitives are codec halves where they exist" idea mirror
 * `http-post-content/payload-decoder.ts`.
 */

import type { Output } from "@bandeira-tech/b3nd-core/types";
import { BadRequest, Unauthorized } from "../../router/errors.ts";
import { hmacSha256Hex, timingSafeEqual } from "../hmac.ts";

// ── The contract ──

/**
 * What `verify` and `decode` see. The raw `body` bytes are read once by
 * the route and shared with both hooks so a signature check and a JSON
 * parse never disagree on the exact bytes (and the body is consumable
 * only once).
 */
export interface WebhookContext {
  /** The original Request. */
  req: Request;
  /** Raw request body bytes — already buffered, safe to read repeatedly. */
  body: Uint8Array;
  /** Convenience alias for `req.headers`. */
  headers: Headers;
  /** Path captures — `{ source }` from `/api/v1/webhooks/in/:source`. */
  params: Record<string, string>;
}

/** Authenticate a delivery. Throw {@link Unauthorized} to reject. */
export type WebhookVerify = (ctx: WebhookContext) => void | Promise<void>;

/**
 * Map a verified delivery to rig outputs. One delivery may yield many
 * outputs (batched event push). Throw {@link BadRequest} on a malformed
 * payload.
 */
export type WebhookDecode = (
  ctx: WebhookContext,
) => Output[] | Promise<Output[]>;

/** One external sender's verify + decode pair. */
export interface WebhookSource {
  /** Optional authenticity check. Omit for an endpoint guarded elsewhere. */
  verify?: WebhookVerify;
  /** Required mapping from delivery → outputs. */
  decode: WebhookDecode;
}

// ── verify helpers ──

export interface HmacVerifyOptions {
  /** Shared secret the sender signs with. */
  secret: string;
  /** Header carrying the signature. Default `"X-B3nd-Signature"`. */
  header?: string;
  /**
   * Prefix the sender prepends to the hex digest, stripped before
   * comparison. Default `"sha256="` (GitHub / B3nd-sender convention).
   * Pass `""` for a bare hex digest.
   */
  prefix?: string;
}

/**
 * HMAC-SHA256 signature verification over the raw body. Mirrors what
 * {@link ../out/sender.ts} produces, so a B3nd node webhooking out is
 * accepted here unchanged. Missing or mismatched signature →
 * {@link Unauthorized}.
 */
function hmacSha256(opts: HmacVerifyOptions): WebhookVerify {
  const header = opts.header ?? "X-B3nd-Signature";
  const prefix = opts.prefix ?? "sha256=";
  return async ({ body, headers }) => {
    const presented = headers.get(header);
    if (!presented) throw new Unauthorized(`Missing ${header}`);
    if (prefix && !presented.startsWith(prefix)) {
      throw new Unauthorized(`Malformed ${header}`);
    }
    const expected = await hmacSha256Hex(opts.secret, body);
    const got = prefix ? presented.slice(prefix.length) : presented;
    if (!timingSafeEqual(got.toLowerCase(), expected)) {
      throw new Unauthorized("Signature mismatch");
    }
  };
}

/**
 * Constant-token check against a header (shared-secret bearer style).
 * Use for senders that authenticate with a static token rather than a
 * body signature.
 */
function headerToken(opts: {
  token: string;
  header?: string;
}): WebhookVerify {
  const header = opts.header ?? "Authorization";
  return ({ headers }) => {
    const presented = headers.get(header) ?? "";
    if (!timingSafeEqual(presented, opts.token)) {
      throw new Unauthorized(`Invalid ${header}`);
    }
  };
}

export const verify = { hmacSha256, headerToken };

// ── decode helpers ──

/**
 * Parse the body as JSON, then hand it to `map` to produce outputs.
 * Invalid JSON → {@link BadRequest}; a throwing `map` propagates (throw
 * {@link BadRequest} from it for malformed-but-parseable payloads).
 */
function json(
  map: (event: unknown, ctx: WebhookContext) => Output[] | Promise<Output[]>,
): WebhookDecode {
  const decoder = new TextDecoder();
  return (ctx) => {
    let event: unknown;
    try {
      event = JSON.parse(decoder.decode(ctx.body));
    } catch {
      throw new BadRequest("Invalid JSON body");
    }
    return map(event, ctx);
  };
}

export const decode = { json };
