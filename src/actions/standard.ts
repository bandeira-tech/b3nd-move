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
 *   on: { method: "GET", path: "/api/v1/status" },
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

/** `rig.status()`. */
export const statusAction: Action<readonly [], Promise<StatusResult>> = (rig) =>
  Promise.resolve(rig.status());

/** `rig.receive(outputs)`. */
export const receiveAction: Action<
  readonly [outputs: Output[]],
  PromiseLike<ReceiveResult[]>
> = (rig, [outputs]) => rig.receive(outputs);

/** `rig.read(urls)`. */
export const readAction: Action<
  readonly [urls: string[]],
  Promise<Output[]>
> = (rig, [urls]) => rig.read(urls);

/** `rig.observe(urls, signal)`. The signal flows from the dispatcher. */
export const observeAction: Action<
  readonly [urls: string[]],
  AsyncIterable<readonly string[]>
> = (rig, [urls], signal) => rig.observe(urls, signal);

/**
 * No-op action — for routes whose work happens entirely in `decode`
 * (control frames that mutate transport state through a closure). The
 * route's `encode` typically returns `undefined` so the dispatcher
 * renders no wire response.
 */
export const noopAction: Action<readonly unknown[], void> = () => {};
