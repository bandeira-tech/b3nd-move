/**
 * @module
 * Standard action functions — one thin wrapper per rig method.
 *
 * Every transport routes a wire request to an `action` function inside
 * its `Route`. The four standard ones bound here cover the rig's full
 * surface: `status`, `receive`, `read`, `observe`. Custom routes
 * (observe-cancel, fire-and-forget control frames, …) supply their
 * own function — see `src/router/route.ts` for the contract.
 *
 * @example
 * ```ts
 * import { statusAction } from "@bandeira-tech/b3nd-move/actions/standard";
 *
 * route({
 *   on: httpRequest("GET", "/api/v1/status"),
 *   decode: () => [] as const,
 *   action: statusAction,
 *   encode: (res) => json(res),
 * });
 * ```
 */

import type {
  Output,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import type { Action } from "../router/route.ts";
import { defaultScheduler, type Scheduler } from "./scheduler.ts";

/** `rig.status()`. */
export const statusAction: Action<readonly [], Promise<StatusResult>> = (rig) =>
  Promise.resolve(rig.status());

/** `rig.receive(outputs)`. */
export const receiveAction: Action<
  readonly [outputs: Output[]],
  PromiseLike<ReceiveResult[]>
> = (rig, [outputs]) => rig.receive(outputs);

/**
 * Build a `readAction` bound to a host-supplied `Scheduler`.
 *
 * The action calls `rig.read(urls)` and then materializes each slot
 * (turning `ReadableStream<Uint8Array>` payloads into `Uint8Array`)
 * through the scheduler. The scheduler decides *how* the per-slot
 * runners execute — `Promise.all`, a concurrency cap, a byte-budget
 * queue, a token bucket, whatever the host's workload needs.
 *
 * Default scheduler = `defaultScheduler` (`Promise.all`), which
 * preserves the pre-seam behavior. Inject a custom scheduler when the
 * default is operationally wrong for your host.
 *
 * **Why a factory and not a `Rig.read` option?** The scheduler is an
 * action-construction-time concern, not a per-call one. A host wires
 * its scheduler once when it builds its routes; every read served by
 * that route uses that policy. Per-call injection would push policy
 * decisions onto callers that don't know them.
 *
 * **Why a callback and not a `{ concurrency: number }` config?** A
 * config locks the seam to one operational dimension. A callback is
 * dimensionless — the host expresses any policy it needs (concurrency,
 * byte budget, token bucket, time-windowed) by *being* the scheduler.
 *
 * See [`./scheduler.ts`](./scheduler.ts) for the `Scheduler` contract
 * and example host implementations.
 *
 * Background: round-3 of the payload-shape contract at
 * `immutable://open/cc-chat/20260624224342-payload-contract/` — each
 * layer delivers its promised output by transforming whatever upstream
 * gave; operational policy belongs to the host.
 */
export function makeReadAction(
  scheduler: Scheduler = defaultScheduler,
): Action<readonly [urls: string[]], Promise<Output[]>> {
  return async (rig, [urls], signal) => {
    const outs = await rig.read(urls);
    return materializeStreamsWith(outs, scheduler, signal);
  };
}

/**
 * `rig.read(urls)`, with any `ReadableStream<Uint8Array>` payloads
 * materialized to `Uint8Array` before the result reaches the transport
 * encoder.
 *
 * HTTP and gRPC deliver bytes end-to-end (binary wire formats). WS and
 * MCP normalize the *shape* (stream → `Uint8Array`) but their JSON
 * envelopes do not preserve `Uint8Array` byte-encoding — a `Uint8Array`
 * payload becomes `{"0":n,"1":n,…}` on those wires. Bytes round-trip
 * on WS / MCP is a follow-up. The materialize still lives here, at the
 * shared action, so every transport gets a concrete payload per slot
 * without demanding upstream clients (b3nd-save fs/s3/ipfs, custom
 * adapters, …) pre-conform to any particular wire's pre-condition.
 *
 * Materialization is per-slot, scheduled through `defaultScheduler`
 * (`Promise.all`); other payload shapes (`Uint8Array`, JSON-able,
 * `null`) pass through untouched. The cost is the obvious one — a 2 GB
 * stream becomes a 2 GB allocation in the route handler. Hosts that
 * need true streaming use the in-process Rig directly (`rig.read()`
 * returns the union shape unchanged) rather than going through a wire.
 *
 * The dispatcher's per-request `AbortSignal` flows into the stream
 * pump via `pipeTo({ signal })`, so an aborted request cancels stream
 * consumption at chunk boundaries and the rejection propagates through
 * the scheduler to the encoder — the runtime closes the response
 * naturally.
 *
 * Hosts that need to cap fan-out (concurrency, byte budget,
 * backpressure) build their own action via `makeReadAction(scheduler)`
 * — see [`./scheduler.ts`](./scheduler.ts).
 *
 * Background: round-3 of the payload-shape contract at
 * `immutable://open/cc-chat/20260624224342-payload-contract/` — each
 * layer delivers its promised output by transforming whatever upstream
 * gave.
 */
export const readAction: Action<
  readonly [urls: string[]],
  Promise<Output[]>
> = makeReadAction();

function materializeStreamsWith(
  outs: readonly Output[],
  scheduler: Scheduler,
  signal: AbortSignal,
): Promise<Output[]> {
  const slots = outs.map(
    ([uri, payload]) => async (slotSignal: AbortSignal): Promise<Output> => {
      if (
        payload &&
        typeof payload === "object" &&
        typeof (payload as ReadableStream<Uint8Array>).getReader === "function"
      ) {
        // Use pipeTo with signal so an abort cancels the stream cleanly
        // at chunk boundaries — Response.arrayBuffer() has no cancel hook.
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
        return [uri, merged] as Output;
      }
      return [uri, payload] as Output;
    },
  );
  return scheduler(slots, signal);
}

/** `rig.observe(urls, signal)`. The signal flows from the dispatcher. */
export const observeAction: Action<
  readonly [urls: string[]],
  AsyncIterable<readonly string[]>
> = (rig, [urls], signal) => rig.observe(urls, signal);
