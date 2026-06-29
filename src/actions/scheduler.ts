/**
 * @module
 * Scheduler — host-supplied callback that decides how to materialize
 * read slots.
 *
 * `readAction` ships a default scheduler — `Promise.all` over the slot
 * runners. Hosts inject their own when they need concurrency,
 * backpressure, or byte-budget enforcement: a p-limit semaphore, a
 * token bucket, a byte-budget queue, whatever matches the workload.
 *
 * **Cores stay puritan.** Per the round-3 payload contract
 * (`immutable://open/cc-chat/20260624224342-payload-contract/`),
 * operational policy — "how many streams pump at once," "how many bytes
 * may we allocate in flight," "do we reject or queue" — lives in the
 * host, not in `b3nd-move`. The package ships a typed seam and the most
 * permissive default; the host plugs in policy through that seam.
 *
 * **Scope.** The contract is intentionally narrow: a callback that
 * takes an array of slot runners (each running with the dispatcher's
 * `AbortSignal`) and returns the materialized outputs. No
 * `concurrency: number` config object — that would push *one* operational
 * dimension into the package and dictate the policy's shape. The
 * callback is the dimensionless seam; the host expresses any policy it
 * needs by *being* the scheduler.
 *
 * **AbortSignal flow.** The dispatcher's signal is threaded into the
 * scheduler and into each individual slot runner. A scheduler that
 * queues slots can still honor abort: when the signal fires, it stops
 * starting new slots, and in-flight slot runners see the same signal
 * inside their `pipeTo`.
 *
 * @example Default — preserve current behavior
 * ```ts
 * import { defaultScheduler } from "@bandeira-tech/b3nd-move/actions/scheduler";
 * // Equivalent to: Promise.all(slots.map((s) => s(signal)))
 * ```
 *
 * @example Host-supplied p-limit-style concurrency cap
 * ```ts
 * import pLimit from "p-limit";
 * import { makeReadAction } from "@bandeira-tech/b3nd-move/actions/standard";
 * import type { Scheduler } from "@bandeira-tech/b3nd-move/actions/scheduler";
 *
 * const limit = pLimit(4);
 * const scheduler: Scheduler = (slots, signal) =>
 *   Promise.all(slots.map((slot) => limit(() => slot(signal))));
 *
 * const readAction = makeReadAction(scheduler);
 * ```
 */

/**
 * A scheduler decides how a batch of read slots is materialized.
 *
 * Each entry in `slots` is a per-slot runner. The runner takes an
 * `AbortSignal` (typically the dispatcher's signal, possibly the
 * scheduler's own derived signal) and returns the materialized output
 * for that slot.
 *
 * The scheduler returns the array of materialized outputs in the same
 * order as the input slots. A scheduler that rejects (because the
 * abort fired, because it chose to drop work) rejects the whole batch —
 * never silently drop slots.
 */
export type Scheduler = <T>(
  slots: ReadonlyArray<(signal: AbortSignal) => Promise<T>>,
  signal: AbortSignal,
) => Promise<T[]>;

/**
 * Default scheduler: `Promise.all` over the slot runners. Preserves
 * the pre-seam behavior of `readAction`. Use this (implicitly, by
 * calling `readAction` without injection) unless you have an
 * operational reason to swap it.
 */
export const defaultScheduler: Scheduler = <T>(
  slots: ReadonlyArray<(signal: AbortSignal) => Promise<T>>,
  signal: AbortSignal,
): Promise<T[]> => Promise.all(slots.map((slot) => slot(signal)));
