/**
 * @module
 * `wsJsonEnvelope` — today's baked WS behavior, made explicit.
 *
 * Packages the default WS read/receive codec as an operator-declared
 * value. Today the WS service hardcodes its decode/encode logic inline
 * in `src/ws/read.ts` and `src/ws/receive.ts`; this codec captures
 * that exact behavior so Task 9 can wire it in and make the seam
 * configurable without changing any observable wire behavior.
 *
 * ## Wire shape
 *
 * **Server → client (read)**:
 *   `{ id, success: true, data: Output[] }` where stream payloads have
 *   been materialized to `Uint8Array`. The WS service `JSON.stringify`s
 *   the whole envelope; `Uint8Array` values emerge as `{"0":n,"1":n,…}`
 *   (the documented KNOWN LIMITATION — see WS README).
 *
 * **Server → client (receive)**:
 *   `{ id, success: true, data: ReceiveResult[] }` unchanged.
 *
 * **Client → server (read)**:
 *   `{ type: "read", id, payload: { urls: string[] } }`.
 *   `encodeReadRequest(urls)` returns `{ urls }`.
 *
 * **Client → server (receive)**:
 *   `{ type: "receive", id, payload: Output[] }`.
 *   `encodeReceiveRequest(outputs)` returns `outputs` raw.
 *
 * ## Validation errors
 *
 * `decodeRead` and `decodeReceive` throw `TypeError` (not `BadRequest`)
 * on invalid input. The route layer (Task 9) catches and rethrows as
 * `BadRequest` so the wire error envelope is correct. Keeping `TypeError`
 * here lets the codec stay transport-agnostic.
 */

import type { Output, ReceiveResult } from "@bandeira-tech/b3nd-core/types";
import type { WsBatchCodec } from "../../ws/codec.ts";
import { validateOutputs, validateUrls } from "../../actions/validate.ts";
import { defaultScheduler, type Scheduler } from "../scheduler.ts";
import { materializeStreams } from "../materialize.ts";

export interface WsJsonEnvelopeOptions {
  /** Fan-out scheduler for per-slot stream materialization. Defaults to `Promise.all`. */
  scheduler?: Scheduler;
}

/**
 * Returns a `WsBatchCodec` that replicates today's baked WS behavior.
 *
 * @param opts.scheduler  Fan-out policy for stream materialization.
 *   Defaults to `Promise.all`. Inject a semaphore or token-bucket
 *   scheduler to cap concurrency without changing the codec contract.
 */
export function wsJsonEnvelope(
  opts: WsJsonEnvelopeOptions = {},
): WsBatchCodec {
  const scheduler = opts.scheduler ?? defaultScheduler;

  return {
    /**
     * Server: materialize any `ReadableStream<Uint8Array>` slot payloads
     * to concrete `Uint8Array` values. The WS service then
     * `JSON.stringify`s the full envelope, producing the lossy
     * `{"0":n,"1":n,…}` shape for bytes (KNOWN LIMITATION, see README).
     */
    async encodeRead(outputs, ctx): Promise<Output[]> {
      return await materializeStreams(outputs, scheduler, ctx.signal);
    },

    /**
     * Server: return `results` unchanged. `ReceiveResult[]` is already
     * JSON-serializable; no transformation needed.
     */
    encodeReceive(results, _ctx): ReceiveResult[] {
      return results;
    },

    /**
     * Server: extract and validate `{ urls: string[] }` from the inbound
     * WS read payload. Throws `TypeError` on invalid shape.
     */
    decodeRead(payload): string[] {
      const urls = (payload as { urls?: unknown } | null)?.urls;
      const v = validateUrls(urls);
      if (!v.ok) throw new TypeError(v.error);
      return v.value;
    },

    /**
     * Server: validate the inbound WS receive payload as `Output[]`.
     * Throws `TypeError` on invalid shape.
     */
    decodeReceive(payload): Output[] {
      const v = validateOutputs(payload);
      if (!v.ok) throw new TypeError(v.error);
      return v.value;
    },

    /**
     * Client: return the parsed `data` field as-is (cast to `Output[]`).
     * The lossy `{"0":n,"1":n,…}` byte shape is the consumer's concern
     * — documented in WS README; no silent coercion here.
     */
    decodeReadResponse(data): Output[] {
      return data as Output[];
    },

    /**
     * Client: return the parsed `data` field as-is (cast to `ReceiveResult[]`).
     */
    decodeReceiveResponse(data): ReceiveResult[] {
      return data as ReceiveResult[];
    },

    /**
     * Client: wrap `urls` in the `{ urls }` shape the WS server expects
     * as the read request payload.
     */
    encodeReadRequest(urls): { urls: string[] } {
      return { urls };
    },

    /**
     * Client: return `outputs` raw. The WS server expects a bare `Output[]`
     * as the receive request payload.
     */
    encodeReceiveRequest(outputs): Output[] {
      return outputs;
    },
  };
}
