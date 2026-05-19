/**
 * @module
 * Action call dispatch — the one place that maps `(rig, call)` to the
 * matching rig method.
 *
 * Every transport (`http`, `grpc/http`, `ws`, `mcp`, the content
 * facets) routes a wire request to one of four rig actions:
 * `status`, `receive`, `read`, `observe`. Today each service inlines
 * its own switch. This module hands them a single, typed
 * `ActionCall` data type and a `runAction` function so the dispatch
 * lives in one place.
 *
 * Used by transports directly today; consumed by the upcoming
 * route-table layer that turns each transport's wire dispatch into a
 * declarative list of `(match, build, respond)` triples.
 *
 * @example
 * ```ts
 * import { runAction } from "@bandeira-tech/b3nd-move/actions/run";
 *
 * const out = await runAction(rig, {
 *   action: "read",
 *   urls: ["mutable://app/x"],
 * });
 * // out: Output[]  — overload narrows from the literal `action`.
 * ```
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";

/** Action names, also used verbatim as the WebSocket envelope `type`. */
export type ActionName = "status" | "receive" | "read" | "observe";

/**
 * The full args needed to invoke one action on a rig. Discriminated by
 * `action` so callers narrow with a `switch`.
 *
 * Observe carries its own `AbortSignal` so the route layer can wire
 * cancellation without leaking transport-specific lifecycle.
 */
export type ActionCall =
  | { action: "status" }
  | { action: "receive"; outputs: Output[] }
  | { action: "read"; urls: string[] }
  | { action: "observe"; urls: string[]; signal: AbortSignal };

/**
 * Dispatch an `ActionCall` to the matching rig method. Pure passthrough
 * — no validation (do that upstream when building the call), no error
 * shaping (let the rig throw, transports translate).
 *
 * Overloaded on `call.action` so the return type narrows at the call
 * site: a route whose action is `"read"` sees `Promise<Output[]>`,
 * not `unknown`. The `receive` overload returns the rig's
 * `PromiseLike<ReceiveResult[]>` (an `OperationHandle`) — `await` it
 * exactly as you would the rig directly.
 */
export function runAction(
  rig: Rig,
  call: { action: "status" },
): Promise<StatusResult>;
export function runAction(
  rig: Rig,
  call: { action: "receive"; outputs: Output[] },
): PromiseLike<ReceiveResult[]>;
export function runAction(
  rig: Rig,
  call: { action: "read"; urls: string[] },
): Promise<Output[]>;
export function runAction(
  rig: Rig,
  call: { action: "observe"; urls: string[]; signal: AbortSignal },
): AsyncIterable<Output<string[]>>;
export function runAction(
  rig: Rig,
  call: ActionCall,
):
  | Promise<StatusResult>
  | PromiseLike<ReceiveResult[]>
  | Promise<Output[]>
  | AsyncIterable<Output<string[]>> {
  switch (call.action) {
    case "status":
      return rig.status();
    case "receive":
      return rig.receive(call.outputs);
    case "read":
      return rig.read(call.urls);
    case "observe":
      return rig.observe(call.urls, call.signal);
  }
}
