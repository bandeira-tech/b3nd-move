/**
 * @module
 * Standard action functions — one thin wrapper per pin method.
 *
 * Every transport routes a wire request to an `action` function inside
 * its `Route`. The four standard ones bound here cover the pin's full
 * surface: `status`, `receive`, `read`, `observe`. Custom routes
 * supply their own function — see `src/router/route.ts` for the
 * contract.
 *
 * Materialization of `ReadableStream<Uint8Array>` payloads (turning
 * them into concrete `Uint8Array` per slot) is the operator-declared
 * codec's responsibility, not the action layer's. Each transport's
 * batch-payload codec — `httpOutputsFrame`, `wsJsonEnvelope`,
 * `grpcProto`, `mcpTextJsonStringify`, etc. — handles materialization
 * inside its own encoder when its wire requires a concrete shape;
 * codecs that stream (e.g. http-get-content's pass-through, future
 * chunked variants) pass streams through unchanged.
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

/** `pin.status()`. */
export const statusAction: Action<readonly [], Promise<StatusResult>> = (pin) =>
  Promise.resolve(pin.status());

/** `pin.receive(outputs)`. */
export const receiveAction: Action<
  readonly [outputs: Output[]],
  PromiseLike<ReceiveResult[]>
> = (pin, [outputs]) => pin.receive(outputs);

/**
 * `pin.read(urls)` — passthrough. The shared action owns no wire
 * knowledge; per-transport codecs materialize stream payloads when
 * the wire requires a concrete shape (see `src/codecs/<wire>/`).
 */
export const readAction: Action<
  readonly [urls: string[]],
  Promise<Output[]>
> = (pin, [urls]) => pin.read(urls);

/** `pin.observe(urls, signal)`. The signal flows from the dispatcher. */
export const observeAction: Action<
  readonly [urls: string[]],
  AsyncIterable<readonly string[]>
> = (pin, [urls], signal) => pin.observe(urls, signal);
