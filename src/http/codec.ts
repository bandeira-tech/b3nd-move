/**
 * @module
 * Batch codec contract for the HTTP read response + receive body.
 *
 * `httpApi(rig, { codec })` requires an `HttpBatchCodec`. Its two
 * halves are the wire's full shape contract for the batch routes:
 *
 *   - `encode(outputs, ctx)` shapes `rig.read(urls)` results into the
 *     HTTP read response. Codecs that materialize streams do so here;
 *     the dispatcher's `AbortSignal` flows in via `ctx.signal`.
 *   - `decode(req)` parses the receive request body into the
 *     `Output[]` the rig will see.
 *
 * The codec is a *symmetric pair*; the same object is imported by the
 * operator (server-side, via `httpApi`) and by the app developer
 * (client-side, via `HttpClient`'s `codec` config). If they don't
 * match, the app doesn't work — same as any wire mismatch.
 *
 * Distinct from `Codec` in `src/codecs/codec.ts`, which is HTTP-
 * specific too but operates on *one* output at a time for the single-
 * URI GET/POST content facets (`httpGetContentApi`,
 * `httpPostContentApi`).
 *
 * See the spec: `docs/superpowers/specs/2026-06-30-operator-declared-codecs-design.md`.
 */

import type { Output } from "@bandeira-tech/b3nd-core/types";

/** Per-request context handed to `encode`. */
export interface HttpEncodeCtx {
  /** The original Request — exposed so negotiating codecs can inspect Accept etc. */
  req: Request;
  /** The dispatcher's per-request abort signal. Materializing codecs thread this through `pipeTo({ signal })`. */
  signal: AbortSignal;
}

/** Symmetric codec for the HTTP batch routes (read response + receive body). */
export interface HttpBatchCodec {
  /** Server side: shape `Output[]` (from `rig.read`) into the read response. */
  encode(outputs: Output[], ctx: HttpEncodeCtx): Response | Promise<Response>;
  /** Server side: parse the receive request body into `Output[]` (for `rig.receive`). */
  decode(req: Request): Output[] | Promise<Output[]>;
  /** Client side: parse a successful read response into `Output[]`. Dual of `encode`. */
  decodeReadResponse(res: Response): Output[] | Promise<Output[]>;
}
