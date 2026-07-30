/**
 * @module
 * Outputs-frame codec — packs / unpacks a list of `Output` tuples
 * `[uri, payload]` into a single self-delimiting buffer.
 *
 *   slot = <u8 flag><u16 uri-len BE><uri utf8><u32 payload-len BE><payload>
 *   buf  = slot × N (read to end of buffer)
 *
 * `flag` is `1` when `payload` is a `Uint8Array` (raw bytes on the
 * wire) and `0` when it's any other value (the codec JSON-stringifies
 * it and UTF-8 encodes the result — exactly the gRPC `payloadIsBinary`
 * fallback in `../grpc/proto/convert.ts`, just inlined per slot).
 * Bytes payloads round-trip without any JSON layer touching them.
 *
 * URI length is a u16 (the same ceiling as `url-list.ts`); payload
 * length is a u32 (matching receive's `bytes-list` at `lenSize: 4`).
 *
 * Used by `../http/read.ts` to ship `Output<unknown>[]` over an
 * `application/octet-stream` response without paying `JSON.stringify`
 * on byte payloads — fixing the asymmetry where `receive` posts opaque
 * bytes but `read` used to come back JSON-mangled.
 */

import type { Output } from "@bandeira-tech/b3nd-core/types";

const URI_MAX = 0xffff; // u16
const PAYLOAD_MAX = 0xffffffff; // u32

export interface OutputsFrameOptions {
  /** Hard cap on slot count. Default `1024`. */
  maxCount?: number;
  /** Hard cap on a single payload's byte length. Default `4 GiB - 1`. */
  maxPayloadBytes?: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

/**
 * Encode an `Output[]` list to a single buffer. Throws `TypeError` on
 * invalid URI (non-string / empty), `RangeError` on size overflow,
 * and propagates any `JSON.stringify` error for non-bytes payloads.
 *
 * An `undefined` payload encodes as the `null` miss sentinel:
 * `JSON.stringify(undefined)` is `undefined`, not a string, so encoding it
 * verbatim would emit a zero-length JSON slot that `decodeOutputsFrame`
 * cannot parse.
 */
export function encodeOutputsFrame(
  outputs: readonly Output[],
  options?: OutputsFrameOptions,
): Uint8Array {
  const maxCount = options?.maxCount ?? 1024;
  const maxPayloadBytes = options?.maxPayloadBytes ?? PAYLOAD_MAX;
  if (outputs.length > maxCount) {
    throw new RangeError(`outputs exceeds maxCount=${maxCount}`);
  }

  const uriBufs: Uint8Array[] = [];
  const payloadBufs: Uint8Array[] = [];
  const flags: number[] = [];
  let total = 0;
  for (const [uri, payload] of outputs) {
    if (typeof uri !== "string" || uri.length === 0) {
      throw new TypeError("Output URI must be a non-empty string");
    }
    const u = enc.encode(uri);
    if (u.length > URI_MAX) {
      throw new RangeError(`URI exceeds ${URI_MAX} bytes (length=${u.length})`);
    }
    let p: Uint8Array;
    let flag: number;
    if (payload instanceof Uint8Array) {
      p = payload;
      flag = 1;
    } else {
      p = enc.encode(JSON.stringify(payload ?? null));
      flag = 0;
    }
    if (p.length > maxPayloadBytes) {
      throw new RangeError(
        `payload exceeds maxPayloadBytes=${maxPayloadBytes} (length=${p.length})`,
      );
    }
    uriBufs.push(u);
    payloadBufs.push(p);
    flags.push(flag);
    total += 1 + 2 + u.length + 4 + p.length;
  }

  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 0;
  for (let i = 0; i < outputs.length; i++) {
    buf[off] = flags[i];
    off += 1;
    view.setUint16(off, uriBufs[i].length, false);
    off += 2;
    buf.set(uriBufs[i], off);
    off += uriBufs[i].length;
    view.setUint32(off, payloadBufs[i].length, false);
    off += 4;
    buf.set(payloadBufs[i], off);
    off += payloadBufs[i].length;
  }
  return buf;
}

/**
 * Decode an outputs-frame buffer into `Output[]`. Raw-bytes payloads
 * are returned as subarray views into `buf` — no copies. JSON-fallback
 * slots are `JSON.parse`d. Throws on truncation, bad UTF-8 / JSON, or
 * policy violation; the route layer surfaces those as transport errors.
 *
 * A zero-length JSON-fallback slot decodes to the `null` miss sentinel.
 * No `JSON.stringify` output is ever empty, so the length is unambiguous;
 * encoders predating the `undefined` normalization above emit that shape
 * for an absent payload.
 */
export function decodeOutputsFrame(
  buf: Uint8Array,
  options?: OutputsFrameOptions,
): Output[] {
  const maxCount = options?.maxCount ?? 1024;
  const maxPayloadBytes = options?.maxPayloadBytes ?? PAYLOAD_MAX;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Output[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 1 > buf.length) throw new TypeError("Truncated slot flag");
    const flag = buf[off];
    off += 1;
    if (flag !== 0 && flag !== 1) {
      throw new TypeError(`Invalid slot flag: ${flag}`);
    }
    if (off + 2 > buf.length) throw new TypeError("Truncated URI length");
    const uriLen = view.getUint16(off, false);
    off += 2;
    if (uriLen === 0) throw new TypeError("Empty URI in slot");
    if (off + uriLen > buf.length) throw new TypeError("Truncated URI body");
    let uri: string;
    try {
      uri = dec.decode(buf.subarray(off, off + uriLen));
    } catch {
      throw new TypeError("Invalid UTF-8 in URI");
    }
    off += uriLen;
    if (off + 4 > buf.length) throw new TypeError("Truncated payload length");
    const payloadLen = view.getUint32(off, false);
    off += 4;
    if (payloadLen > maxPayloadBytes) {
      throw new TypeError(
        `payload exceeds maxPayloadBytes=${maxPayloadBytes} (length=${payloadLen})`,
      );
    }
    if (off + payloadLen > buf.length) {
      throw new TypeError("Truncated payload body");
    }
    const payloadBytes = buf.subarray(off, off + payloadLen);
    off += payloadLen;
    let payload: unknown;
    if (flag === 1) {
      payload = payloadBytes;
    } else if (payloadLen === 0) {
      payload = null;
    } else {
      let text: string;
      try {
        text = dec.decode(payloadBytes);
      } catch {
        throw new TypeError("Invalid UTF-8 in JSON-fallback payload");
      }
      try {
        payload = JSON.parse(text);
      } catch {
        throw new TypeError("Invalid JSON in fallback payload");
      }
    }
    out.push([uri, payload]);
    if (out.length > maxCount) {
      throw new TypeError(`outputs exceeds maxCount=${maxCount}`);
    }
  }
  return out;
}
