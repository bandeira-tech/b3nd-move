/**
 * @module
 * URL-list framer — packs / unpacks a list of URL-shaped strings
 * into a single url-safe-base64 string, suitable for a wire
 * envelope's routing slot (today: the `?u=` query parameter on the
 * batch HTTP routes).
 *
 * "URL" here is the superset string shape: a URI (specific
 * resource identifier, as `receive` sends) is a degenerate URL,
 * and a locator carrying higher-order info (patterns, listings,
 * queries — as `read` and `observe` send) is the full URL form.
 * The move layer doesn't interpret either; this codec just frames
 * the bytes for transit. Consumers decide what the strings mean.
 *
 * This is a thin wrapper over `./bytes-list.ts`: encode UTF-8 bytes
 * for each entry, frame them at `lenSize: 2` (URL-shaped strings
 * are short — 64 KiB each is plenty), wrap the result in url-safe
 * base64 so the bytes survive transit inside a URL.
 *
 *   buf  = bytesList(UTF8(url) for each url, lenSize: 2)
 *   wire = url-safe base64 of `buf`, unpadded
 *
 * Why one combined `?u=` (vs. repeated `?u=&u=`): less overhead per
 * URL (no repeated `&u=` keying, no percent-encoding of URL scheme
 * separators), and the base64 hides arbitrary URL bytes from query
 * parsers that might choke on unusual content.
 */

import {
  type BytesListOptions,
  decodeBytesList,
  encodeBytesList,
} from "./bytes-list.ts";

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
 * Encode a non-empty list of URLs into the wire string.
 *
 * Throws `TypeError` for empty / non-string entries — invariants
 * the caller is expected to uphold. Throws `RangeError` if any
 * URL's UTF-8 encoding exceeds 65535 bytes (the `bytes-list`
 * u16 ceiling).
 */
export function encodeUrlList(urls: readonly string[]): string {
  if (urls.length === 0) throw new TypeError("URL list must be non-empty");
  const enc = new TextEncoder();
  const slots: Uint8Array[] = [];
  for (const url of urls) {
    if (typeof url !== "string" || url.length === 0) {
      throw new TypeError("URL must be a non-empty string");
    }
    slots.push(enc.encode(url));
  }
  return toUrlsafeB64(encodeBytesList(slots, { lenSize: 2 }));
}

export interface DecodeUrlListOptions {
  /** Hard cap on URLs per request. Default `1024`. */
  maxCount?: number;
}

/**
 * Decode a url-list wire string back into the URL array.
 *
 * Throws on malformed input (bad base64, truncated frame, count
 * over `maxCount`, invalid UTF-8). The route layer catches these
 * as `BadRequest`.
 */
export function decodeUrlList(
  param: string,
  options?: DecodeUrlListOptions,
): string[] {
  let buf: Uint8Array;
  try {
    buf = fromUrlsafeB64(param);
  } catch {
    throw new TypeError("Malformed url-list base64");
  }
  const opts: BytesListOptions = { lenSize: 2 };
  if (options?.maxCount !== undefined) opts.maxCount = options.maxCount;
  const slots = decodeBytesList(buf, opts);
  if (slots.length === 0) throw new TypeError("URL list is empty");
  const dec = new TextDecoder("utf-8", { fatal: true });
  const urls: string[] = [];
  for (const slot of slots) {
    if (slot.length === 0) throw new TypeError("Empty URL in list");
    let url: string;
    try {
      url = dec.decode(slot);
    } catch {
      throw new TypeError("Invalid UTF-8 in URL");
    }
    urls.push(url);
  }
  return urls;
}
