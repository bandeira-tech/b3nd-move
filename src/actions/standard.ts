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

/** `rig.status()`. */
export const statusAction: Action<readonly [], Promise<StatusResult>> = (rig) =>
  Promise.resolve(rig.status());

/** `rig.receive(outputs)`. */
export const receiveAction: Action<
  readonly [outputs: Output[]],
  PromiseLike<ReceiveResult[]>
> = (rig, [outputs]) => rig.receive(outputs);

/**
 * `rig.read(urls)`, with any `ReadableStream<Uint8Array>` payloads
 * materialized to `Uint8Array` before the result reaches the transport
 * encoder.
 *
 * Every wire b3nd-move ships (HTTP `outputs-frame`, WS JSON envelope,
 * gRPC `ReadResponse`) needs a concrete payload per slot — none of
 * them can serialize a `ReadableStream` as-is. The materialize lives
 * here, at the shared action, so every transport gets the right shape
 * without demanding upstream clients (b3nd-save fs/s3/ipfs, custom
 * adapters, …) pre-conform to any particular wire's pre-condition.
 * Streaming is the medium's natural shape; this action transforms it
 * for delivery.
 *
 * Materialization is per-slot and parallel (`Promise.all`); other
 * payload shapes (`Uint8Array`, JSON-able, `null`) pass through
 * untouched. The cost is the obvious one — a 2 GB stream becomes a
 * 2 GB allocation in the route handler. Hosts that need true streaming
 * use the in-process Rig directly (`rig.read()` returns the union
 * shape unchanged) rather than going through a wire.
 *
 * Background: round-3 of the payload-shape contract at
 * `immutable://open/cc-chat/20260624224342-payload-contract/` — each
 * layer delivers its promised output by transforming whatever upstream
 * gave.
 */
export const readAction: Action<
  readonly [urls: string[]],
  Promise<Output[]>
> = async (rig, [urls]) => {
  const outs = await rig.read(urls);
  return materializeStreams(outs);
};

function materializeStreams(outs: readonly Output[]): Promise<Output[]> {
  return Promise.all(outs.map(async ([uri, payload]) => {
    if (
      payload &&
      typeof payload === "object" &&
      typeof (payload as ReadableStream<Uint8Array>).getReader === "function"
    ) {
      const bytes = new Uint8Array(
        await new Response(payload as ReadableStream<Uint8Array>)
          .arrayBuffer(),
      );
      return [uri, bytes] as Output;
    }
    return [uri, payload] as Output;
  }));
}

/** `rig.observe(urls, signal)`. The signal flows from the dispatcher. */
export const observeAction: Action<
  readonly [urls: string[]],
  AsyncIterable<readonly string[]>
> = (rig, [urls], signal) => rig.observe(urls, signal);
