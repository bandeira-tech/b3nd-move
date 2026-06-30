/**
 * @module
 * Shared stream-materialization helper for HTTP batch codecs.
 *
 * `materializeStreams` walks an `Output[]` array and, for any slot whose
 * payload is a `ReadableStream<Uint8Array>`, pumps the stream to a
 * concrete `Uint8Array` before returning. Non-stream payloads are passed
 * through unchanged.
 *
 * The fan-out is driven by the host-supplied `Scheduler` (default:
 * `Promise.all`). The dispatcher's `AbortSignal` threads into each slot's
 * `pipeTo({ signal })` so an aborted request cancels stream consumption at
 * chunk boundaries.
 *
 * Extraction rationale: both `httpOutputsFrame` (Task 4) and `httpNdjson`
 * (Task 6) need identical materialization semantics — the logic lives here
 * once so the two codecs stay in sync without copy-paste drift.
 */

import type { Output } from "@bandeira-tech/b3nd-core/types";
import type { Scheduler } from "./scheduler.ts";

/**
 * Materialize every `ReadableStream<Uint8Array>` payload in `outputs` to
 * a concrete `Uint8Array`. Non-stream payloads are returned as-is.
 *
 * @param outputs  The slot array from `rig.read` (or an equivalent source).
 * @param scheduler  Fan-out policy; controls per-slot concurrency.
 * @param signal  Per-request abort signal; wired into each slot's `pipeTo`.
 */
export function materializeStreams(
  outputs: readonly Output[],
  scheduler: Scheduler,
  signal: AbortSignal,
): Promise<Output[]> {
  const slots = outputs.map(
    ([uri, payload]) => async (slotSignal: AbortSignal): Promise<Output> => {
      if (
        payload &&
        typeof payload === "object" &&
        typeof (payload as ReadableStream<Uint8Array>).getReader === "function"
      ) {
        const chunks: Uint8Array[] = [];
        let total = 0;
        await (payload as ReadableStream<Uint8Array>).pipeTo(
          new WritableStream<Uint8Array>({
            write(chunk) {
              chunks.push(chunk);
              total += chunk.byteLength;
            },
          }),
          { signal: slotSignal },
        );
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.byteLength;
        }
        return [uri, merged];
      }
      return [uri, payload];
    },
  );
  return scheduler(slots, signal);
}
