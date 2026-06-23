/**
 * @module
 * HMAC-SHA256 over raw bytes — the one crypto primitive the webhooks
 * transport shares across both directions.
 *
 * The outbound sender ({@link ../out/sender.ts}) signs each delivery
 * body and writes the digest into a header; the inbound verifier
 * ({@link ../in/source.ts}) recomputes it over the raw request body and
 * compares. Both sides agree on the same hex encoding here so a B3nd
 * node delivering out can be received by another node's webhook-in
 * without either side reimplementing the signature.
 *
 * Uses Web Crypto (`crypto.subtle`) — available in every runtime this
 * package targets (Deno, Workers, Bun, modern Node). No Node `crypto`
 * dependency, so the module stays universal.
 */

const encoder = new TextEncoder();

/** Cache imported keys by secret so repeated signs/verifies don't re-import. */
const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    keyCache.set(secret, key);
  }
  return key;
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * HMAC-SHA256 of `body` keyed by `secret`, lower-case hex.
 *
 * `body` is bytes, not a string — the signature must be computed over
 * the exact wire bytes so signer and verifier never disagree on
 * encoding. Callers signing a JSON string pass
 * `new TextEncoder().encode(s)`.
 */
export async function hmacSha256Hex(
  secret: string,
  body: Uint8Array,
): Promise<string> {
  const key = await importKey(secret);
  // Copy into a fresh ArrayBuffer-backed view so `subtle.sign` never
  // sees a `SharedArrayBuffer` (its types reject that) or a subarray
  // view with a non-zero offset.
  const data = body.slice();
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return toHex(sig);
}

/**
 * Constant-time string compare. Returns `false` on length mismatch and
 * otherwise XORs every char so the time taken doesn't leak how many
 * leading characters matched. Use for signature comparison — `===`
 * short-circuits and is a timing oracle.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
