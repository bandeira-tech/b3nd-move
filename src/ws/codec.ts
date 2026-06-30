/**
 * @module
 * Batch codec contract for WS read + receive request/response frames.
 *
 * WS's read and receive each have an inbound payload shape and an
 * outbound data shape. The codec owns both halves of both routes:
 *
 *   read:    inbound `{ urls: string[] }`  → outbound `data: Output[]`-shaped
 *   receive: inbound `Output[]`            → outbound `data: ReceiveResult[]`-shaped
 *
 * The transport's WS envelope `{ id, success, data | error }` is
 * always preserved; the codec decides the *shape of `data`* for read
 * responses (lossy `{0:n,…}` vs base64-tagged vs ...).
 *
 * Why two encode methods (not one symmetric pair like HTTP):
 * WS's read and receive go through one socket but produce different
 * shapes; collapsing into a single `encode(outputs)` would force the
 * codec to inspect what kind of routing it's in.
 *
 * Client side gets the inverse: `decodeReadResponse(frame.data)` →
 * `Output[]`; `decodeReceiveResponse(frame.data)` → `ReceiveResult[]`.
 */

import type { Output, ReceiveResult } from "@bandeira-tech/b3nd-core/types";

export interface WsEncodeCtx {
  id: string;
  signal: AbortSignal;
}

export interface WsBatchCodec {
  /** Server: shape `Output[]` (from `rig.read`) into a WS response frame's `data`. */
  encodeRead(outputs: Output[], ctx: WsEncodeCtx): unknown | Promise<unknown>;
  /** Server: shape `ReceiveResult[]` into a WS response frame's `data`. */
  encodeReceive(
    results: ReceiveResult[],
    ctx: WsEncodeCtx,
  ): unknown | Promise<unknown>;
  /** Server: decode the inbound `read` payload into `string[]` (urls). */
  decodeRead(payload: unknown): string[];
  /** Server: decode the inbound `receive` payload into `Output[]`. */
  decodeReceive(payload: unknown): Output[];
  /** Client: parse a successful read response's `data` field into `Output[]`. */
  decodeReadResponse(data: unknown): Output[];
  /** Client: parse a successful receive response's `data` field into `ReceiveResult[]`. */
  decodeReceiveResponse(data: unknown): ReceiveResult[];
  /** Client: shape the outbound `read` request payload (e.g., `{ urls }`). */
  encodeReadRequest(urls: string[]): unknown;
  /** Client: shape the outbound `receive` request payload. */
  encodeReceiveRequest(outputs: Output[]): unknown;
}
