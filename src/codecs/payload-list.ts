/**
 * @module
 * Payload list codec — the `<u32 payload-len><payload-bytes> × N`
 * framing used by the receive route's request body.
 *
 * Pairs with `./uri-list.ts`: URIs ride in the URL, payloads ride in
 * the body, both opaque to the move layer. The route never inspects
 * a single payload byte — it just slices the body into per-URI
 * chunks and hands `Output<Uint8Array>[]` to the rig. Downstream
 * consumers (the actual PIN clients that own the schema) decode at
 * their own boundary.
 *
 * Encoding:
 *
 *   body = <u32 payload-byte-len BE><payload bytes> × N
 *
 * `payload-byte-len = 0` is legal (present-but-empty payload). A
 * single payload caps at the u32 limit (4 GiB) which is well above
 * the `maxPayloadBytes` policy enforced at decode time.
 */

/**
 * Encode a list of opaque payload bytes into the receive body.
 *
 * Throws `RangeError` if any single payload exceeds 4 GiB (the u32
 * length-prefix limit). For empty list — empty body is a legal wire,
 * the caller decides whether to send the request at all.
 */
export function encodePayloads(payloads: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of payloads) {
    if (p.length > 0xffffffff) {
      throw new RangeError(`payload exceeds 4 GiB (length=${p.length})`);
    }
    total += 4 + p.length;
  }
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 0;
  for (const p of payloads) {
    view.setUint32(off, p.length, false);
    off += 4;
    buf.set(p, off);
    off += p.length;
  }
  return buf;
}

export interface DecodePayloadsOptions {
  /** Hard cap on payload count. Default `1024`. */
  maxCount?: number;
  /** Hard cap on a single payload's byte length. Default `1 << 26` (64 MiB). */
  maxPayloadBytes?: number;
}

/**
 * Decode the receive request body into a list of opaque payload
 * slices. Each slice is a `Uint8Array` view into the input buffer —
 * no copies. Throws on truncation or policy violation; the route
 * catches these as `BadRequest`.
 */
export function decodePayloads(
  body: Uint8Array,
  options?: DecodePayloadsOptions,
): Uint8Array[] {
  const maxCount = options?.maxCount ?? 1024;
  const maxPayloadBytes = options?.maxPayloadBytes ?? (1 << 26);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const out: Uint8Array[] = [];
  let off = 0;
  while (off < body.length) {
    if (off + 4 > body.length) {
      throw new TypeError("Truncated payload length prefix");
    }
    const len = view.getUint32(off, false);
    off += 4;
    if (len > maxPayloadBytes) {
      throw new TypeError(
        `payload exceeds maxPayloadBytes=${maxPayloadBytes} (length=${len})`,
      );
    }
    if (off + len > body.length) {
      throw new TypeError("Truncated payload body");
    }
    out.push(body.subarray(off, off + len));
    off += len;
    if (out.length > maxCount) {
      throw new TypeError(`payload list exceeds maxCount=${maxCount}`);
    }
  }
  return out;
}
