/**
 * @module
 * WebSocket specialisation of the generic `Route` + the dispatcher.
 *
 * The transport-shaped bits live here:
 *
 *   WsMatcher    `{ type }` — matches a single envelope `type` value
 *   WsContext    `{ id, payload, abort }` — what decode/encode see
 *   route()      constructor that infers Args/Result from the action fn
 *   dispatchWs   matches one inbound frame, runs the action, yields
 *                zero, one, or many outbound envelopes
 *
 * The data structure itself (`Route`, `Action`) lives in
 * `../router/route.ts` and is transport-agnostic. Wire-adapter errors
 * live in `../router/errors.ts`; their `status` is mapped here into the
 * `error` field of the envelope — WS doesn't carry an HTTP status, but
 * the dispatcher still uses the shared taxonomy so transports stay in
 * sync on what counts as a 400 vs. 500.
 *
 * `observe-cancel` is now a regular route: its action operates on the
 * per-socket `observes` map (a closure captured by the route factory),
 * its `encode` returns `undefined`, and the dispatcher yields no
 * envelope. The service no longer needs to special-case anything.
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import { HttpError } from "../router/errors.ts";
import type { Route } from "../router/route.ts";
import type { WebSocketRequest, WebSocketResponse } from "./client.ts";

/**
 * Internal alias for a WS-specialised `Route`. Not exported — the
 * public name is the generic `Route`. This just keeps the dispatcher
 * and `route()` signatures from spelling out the five type params at
 * every site.
 *
 * `Out` is a union so observe can return an `AsyncIterable` of envelope
 * frames (one per fired batch + a terminator) while unary actions
 * return a single envelope. Routes that don't reply (observe-cancel)
 * have `encode` return `undefined`; the dispatcher yields nothing.
 */
type WsRoute<
  Args extends readonly unknown[] = readonly unknown[],
  Result = unknown,
> = Route<
  Args,
  Result,
  WsMatcher,
  WsContext,
  WebSocketResponse | AsyncIterable<WebSocketResponse>
>;

// ── WS-specific axes of `Route` ──

/** Declarative matcher: the inbound envelope's `type` value. */
export interface WsMatcher {
  type: WebSocketRequest["type"];
}

/** Per-frame context handed to `decode` and `encode`. */
export interface WsContext {
  /** Correlation id from the inbound envelope — copy onto every outbound. */
  id: string;
  /** Raw `payload` field from the inbound envelope; route owns its shape. */
  payload: unknown;
  /**
   * Per-frame abort. The observe route registers this in the
   * socket-level `observes` map (via a closure passed to its factory)
   * so an `observe-cancel` frame with the same `id` can fire it; the
   * abort flows into the rig for streaming actions and is a no-op for
   * unary ones.
   */
  abort: AbortController;
}

/**
 * Type-preserving WS route constructor. Infers `Args`/`Result` from
 * the supplied `action` so `decode`'s tuple and `encode`'s input
 * narrow automatically.
 *
 * The return is erased to the default `WsRoute` so heterogeneous
 * routes share a single table type.
 */
export function route<Args extends readonly unknown[], Result>(
  r: WsRoute<Args, Result>,
): WsRoute {
  // Erase Args/Result to the heterogeneous-table type. The dispatcher
  // re-narrows per-route via the action's runtime closure.
  return r as unknown as WsRoute;
}

// ── Dispatch ──

/**
 * Match `frame` against `routes`, run the first route whose `type`
 * matches, run the action, and yield the encoded envelope(s).
 *
 *   no matching type                            → one envelope, `Unknown type`
 *   decode/action/encode throws HttpError       → one envelope, `error` = message
 *   anything else thrown                        → one envelope, `error` = message
 *   `encode` returns undefined                  → no envelope (fire-and-forget)
 *   unary route                                 → one envelope from encode
 *   streaming route (observe)                   → many envelopes from encode
 *
 * The caller pumps each yielded envelope onto the wire.
 */
export async function* dispatchWs(
  rig: Rig,
  routes: readonly WsRoute[],
  frame: WebSocketRequest,
  abort: AbortController,
): AsyncIterable<WebSocketResponse> {
  for (const r of routes) {
    if (r.on.type !== frame.type) continue;
    const ctx: WsContext = {
      id: frame.id,
      payload: frame.payload,
      abort,
    };
    try {
      const args = await r.decode(ctx);
      const result = await r.action(rig, args, abort.signal);
      const out = await r.encode(result as Awaited<typeof result>, ctx);
      if (out === undefined) return;
      if (isAsyncIterable(out)) {
        yield* out;
      } else {
        yield out;
      }
    } catch (e) {
      yield { id: frame.id, success: false, error: renderError(e) };
    }
    return;
  }
  yield {
    id: frame.id,
    success: false,
    error: `Unknown type: ${frame.type}`,
  };
}

function renderError(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

function isAsyncIterable(
  x: unknown,
): x is AsyncIterable<WebSocketResponse> {
  return typeof x === "object" && x !== null &&
    Symbol.asyncIterator in (x as object);
}
