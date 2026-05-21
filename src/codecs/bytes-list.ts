/**
 * @module
 * Bytes-list framer — packs / unpacks a list of opaque byte slots
 * into a single buffer using length-prefixed framing.
 *
 *   buf = <lenSize prefix BE><slot bytes> × N
 *
 * The same algorithm that powers both the URL list (`./url-list.ts`,
 * `lenSize: 2` plus a string + base64 wrapper) and the receive
 * request body (`lenSize: 4`, raw bytes on the wire). They're not
 * two codecs — they're one codec applied at different sizes for
 * different wire envelopes:
 *
 *   - `lenSize: 2` (u16) — single slot ≤ 64 KiB. Used when many
 *     short slots share a tight envelope (e.g. URLs in a query
 *     string under a URL-length ceiling).
 *   - `lenSize: 4` (u32) — single slot ≤ 4 GiB. Used when slots
 *     are payload-sized and the envelope is an HTTP body.
 *
 * The framer never inspects or copies slot bytes. `decodeBytesList`
 * returns subarray views into the input buffer.
 */

export interface BytesListOptions {
  /**
   * Bytes for each length prefix. `2` allows slots up to 64 KiB;
   * `4` allows slots up to 4 GiB. Default `2`.
   */
  lenSize?: 2 | 4;
  /** Hard cap on slot count. Default `1024`. */
  maxCount?: number;
  /**
   * Hard cap on a single slot's byte length. Default = the maximum
   * the configured `lenSize` can encode.
   */
  maxBytes?: number;
}

const MAX_FOR: Record<2 | 4, number> = { 2: 0xffff, 4: 0xffffffff };

/**
 * Encode a list of byte slots. Throws `RangeError` if any slot
 * exceeds `lenSize`'s ceiling (or the explicit `maxBytes`).
 */
export function encodeBytesList(
  slots: readonly Uint8Array[],
  options?: BytesListOptions,
): Uint8Array {
  const lenSize = options?.lenSize ?? 2;
  const maxBytes = options?.maxBytes ?? MAX_FOR[lenSize];
  let total = 0;
  for (const s of slots) {
    if (s.length > maxBytes) {
      throw new RangeError(
        `slot exceeds maxBytes=${maxBytes} (length=${s.length})`,
      );
    }
    total += lenSize + s.length;
  }
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 0;
  for (const s of slots) {
    if (lenSize === 2) view.setUint16(off, s.length, false);
    else view.setUint32(off, s.length, false);
    off += lenSize;
    buf.set(s, off);
    off += s.length;
  }
  return buf;
}

/**
 * Decode a bytes-list buffer into its slots. Each slot is a
 * subarray view into `buf` — no copies. Throws on truncation or
 * policy violation; consumers (the route layer, etc.) catch these
 * as `BadRequest`.
 */
export function decodeBytesList(
  buf: Uint8Array,
  options?: BytesListOptions,
): Uint8Array[] {
  const lenSize = options?.lenSize ?? 2;
  const maxCount = options?.maxCount ?? 1024;
  const maxBytes = options?.maxBytes ?? MAX_FOR[lenSize];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Uint8Array[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + lenSize > buf.length) {
      throw new TypeError("Truncated slot length prefix");
    }
    const len = lenSize === 2
      ? view.getUint16(off, false)
      : view.getUint32(off, false);
    off += lenSize;
    if (len > maxBytes) {
      throw new TypeError(
        `slot exceeds maxBytes=${maxBytes} (length=${len})`,
      );
    }
    if (off + len > buf.length) {
      throw new TypeError("Truncated slot body");
    }
    out.push(buf.subarray(off, off + len));
    off += len;
    if (out.length > maxCount) {
      throw new TypeError(`bytes list exceeds maxCount=${maxCount}`);
    }
  }
  return out;
}
