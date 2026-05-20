/**
 * @module
 * URI list codec — the `?u=<b64>` query parameter used by the batch
 * routes (`read`, `receive`, `observe`) to carry their URI lists out
 * of the body and into the URL.
 *
 * Frontloading the URIs lets every layer between the client and the
 * rig — routers, auth, observability, caches — see the request
 * identity without reading the body. The body is then free to carry
 * only what's genuinely body-shaped (payloads on `receive`; nothing
 * on `read` and `observe`).
 *
 * Encoding:
 *
 *   payload = <u16 url-byte-len BE><url-utf8> × N
 *   wire    = url-safe base64 of `payload`, unpadded
 *
 * Why length-prefix-frame inside base64 (vs. comma-joined):
 * byte-safe against any URI content, no separator footgun, ~no space
 * cost for typical URIs. A `u16` caps a single URI at 65535 bytes
 * which is far above any sensible URI length.
 *
 * Why one combined `?u=` (vs. repeated `?u=&u=`): less overhead
 * per URI (no repeated `&u=` keying, no percent-encoding of URI
 * scheme separators), and the base64 hides arbitrary URI content
 * from URL parsers that might choke on unusual bytes.
 */

const URLSAFE_TO_STD: Record<string, string> = { "-": "+", "_": "/" };
const STD_TO_URLSAFE: Record<string, string> = { "+": "-", "/": "_" };

function toUrlsafeB64(bytes: Uint8Array): string {
  // Build a binary string in chunks to avoid blowing the call stack
  // for large inputs (apply spreads its argument list).
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin).replace(/[+/=]/g, (c) => c === "=" ? "" : STD_TO_URLSAFE[c]);
}

function fromUrlsafeB64(s: string): Uint8Array {
  const std = s.replace(/[-_]/g, (c) => URLSAFE_TO_STD[c]);
  const pad = std.length % 4 === 0 ? "" : "=".repeat(4 - (std.length % 4));
  const bin = atob(std + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Encode a non-empty list of URIs into the `?u=` value.
 *
 * Throws `TypeError` for empty / non-string entries — invariants the
 * caller is expected to uphold. Throws `RangeError` if any URI's
 * UTF-8 encoding exceeds 65535 bytes (`u16` limit).
 */
export function encodeUriList(uris: readonly string[]): string {
  if (uris.length === 0) throw new TypeError("URI list must be non-empty");
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const uri of uris) {
    if (typeof uri !== "string" || uri.length === 0) {
      throw new TypeError("URI must be a non-empty string");
    }
    const utf8 = enc.encode(uri);
    if (utf8.length > 0xffff) {
      throw new RangeError(`URI exceeds 65535 bytes: ${uri.slice(0, 64)}…`);
    }
    const frame = new Uint8Array(2 + utf8.length);
    frame[0] = (utf8.length >> 8) & 0xff;
    frame[1] = utf8.length & 0xff;
    frame.set(utf8, 2);
    parts.push(frame);
    total += frame.length;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return toUrlsafeB64(buf);
}

export interface DecodeUriListOptions {
  /** Hard cap on URIs per request. Default `1024`. */
  maxCount?: number;
}

/**
 * Decode a `?u=` value back into the URI list.
 *
 * Throws on malformed input (bad base64, truncated frame, length over
 * `maxCount`). The route layer catches these as `BadRequest`.
 */
export function decodeUriList(
  param: string,
  options?: DecodeUriListOptions,
): string[] {
  const maxCount = options?.maxCount ?? 1024;
  let bytes: Uint8Array;
  try {
    bytes = fromUrlsafeB64(param);
  } catch {
    throw new TypeError("Malformed ?u= base64");
  }
  const dec = new TextDecoder("utf-8", { fatal: true });
  const uris: string[] = [];
  let off = 0;
  while (off < bytes.length) {
    if (off + 2 > bytes.length) {
      throw new TypeError("Truncated URI length prefix");
    }
    const len = (bytes[off] << 8) | bytes[off + 1];
    off += 2;
    if (off + len > bytes.length) {
      throw new TypeError("Truncated URI body");
    }
    if (len === 0) throw new TypeError("Empty URI in list");
    let uri: string;
    try {
      uri = dec.decode(bytes.subarray(off, off + len));
    } catch {
      throw new TypeError("Invalid UTF-8 in URI");
    }
    uris.push(uri);
    off += len;
    if (uris.length > maxCount) {
      throw new TypeError(`URI list exceeds maxCount=${maxCount}`);
    }
  }
  if (uris.length === 0) throw new TypeError("URI list is empty");
  return uris;
}
