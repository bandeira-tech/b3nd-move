/**
 * @module
 * Outputs-frame codec — packs / unpacks a list of `Output` tuples
 * `[uri, payload]` into a single self-delimiting buffer.
 *
 *   slot = <u8 flag><u16 uri-len BE><uri utf8><u32 payload-len BE><payload>
 *   buf  = slot × N (read to end of buffer)
 *
 * `flag` is `1` when `payload` is a `Uint8Array` (raw bytes on the
 * wire), `2` when `payload` is `undefined` (a read *miss* — the URI
 * was absent, carried as an empty slot so the value survives the wire
 * as `undefined`, matching the in-process `[uri, undefined]` shape),
 * and `0` for any other value (the codec JSON-stringifies it and
 * UTF-8 encodes the result — exactly the gRPC `payloadIsBinary`
 * fallback in `../grpc/proto/convert.ts`, just inlined per slot).
 * Bytes payloads round-trip without any JSON layer touching them.
 * `null` stays a flag-0 `"null"`, distinct from a flag-2 miss.
 *
 * Backward read compat: a `flag=0` slot with an *empty* payload can
 * only be the pre-flag-2 encoding of a miss (`JSON.stringify(undefined)`
 * is the JS value `undefined`, which UTF-8-encoded is zero bytes — and
 * no real JSON value serializes to `""`). So decode maps an empty
 * flag-0 slot to `undefined` instead of throwing `JSON.parse("")`,
 * letting a fixed client read misses from an un-upgraded server without
 * the miss poisoning the whole batch.
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
const EMPTY = new Uint8Array(0);

/**
 * Encode an `Output[]` list to a single buffer. Throws `TypeError` on
 * invalid URI (non-string / empty), `RangeError` on size overflow,
 * and propagates any `JSON.stringify` error for non-bytes payloads.
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
    } else if (payload === undefined) {
      // Read miss: absent URI. Carry an empty slot, not a mangled JSON
      // one — `JSON.stringify(undefined)` is `undefined`, which would
      // encode empty and then fail `JSON.parse("")` on the whole batch.
      p = EMPTY;
      flag = 2;
    } else {
      const json = JSON.stringify(payload);
      if (json === undefined) {
        // A non-undefined payload whose serialization is `undefined`
        // (a function, a symbol) — reject the slot loudly rather than
        // emit a silent empty flag-0 slot that decodes as a miss.
        throw new TypeError("Output payload is not JSON-serializable");
      }
      p = enc.encode(json);
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
    if (flag !== 0 && flag !== 1 && flag !== 2) {
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
    if (flag === 2) {
      // Read miss: absent URI, empty slot → `undefined`.
      if (payloadLen !== 0) {
        throw new TypeError("Miss slot (flag=2) must have an empty payload");
      }
      payload = undefined;
    } else if (flag === 1) {
      payload = payloadBytes;
    } else if (payloadLen === 0) {
      // Legacy miss: a pre-flag-2 encoder emitted `JSON.stringify(undefined)`
      // as an empty flag-0 slot. No real JSON value serializes to `""`, so
      // this is unambiguously a miss — decode to `undefined` rather than
      // throwing `JSON.parse("")` and sinking the batch.
      payload = undefined;
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
