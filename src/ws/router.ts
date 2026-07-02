/**
 * @module
 * WebSocket specialisation of the generic `Route` + the dispatcher.
 *
 * The transport-shaped bits live here:
 *
 *   WsMatcher    `(frame) => true | null` — function over the inbound
 *                envelope; matcher decides whether this route handles it
 *   WsContext    `{ id, payload, abort }` — what decode/encode see
 *   wsData       helper that builds the common `frame.type === <t>` matcher
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
 * `on` is a function over the frame, not a declarative struct: the
 * matcher owns inspecting the inbound envelope. The dispatcher just
 * calls it. The win is composability — a route can match on any
 * property of the frame (a custom envelope field, payload shape) by
 * supplying its own function, without growing the struct the
 * dispatcher knows about. The common case is built with `wsData(type)`.
 *
 * `observe-cancel` is now a regular route: its action operates on the
 * per-socket `observes` map (a closure captured by the route factory),
 * its `encode` returns `undefined`, and the dispatcher yields no
 * envelope. The service no longer needs to special-case anything.
 */

import type { ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core/types";
import { HttpError } from "../router/errors.ts";
import type { Route } from "../router/route.ts";
import type { WebSocketRequest, WebSocketResponse } from "./client.ts";

/**
 * WS-specialised `Route`. Exported so route factories in `read.ts`,
 * `receive.ts`, etc. can declare their return type explicitly.
 *
 * `Out` is a union so observe can return an `AsyncIterable` of envelope
 * frames (one per fired batch + a terminator) while unary actions
 * return a single envelope. Routes that don't reply (observe-cancel)
 * have `encode` return `undefined`; the dispatcher yields nothing.
 */
export type WsRoute<
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

/**
 * Matcher function. Operates on the raw inbound envelope and returns
 * `true` on a match, `null` to skip. There's no analog to HTTP's 405
 * here — an unmatched frame produces an `Unknown type` error envelope.
 */
export type WsMatcher = (frame: WebSocketRequest) => true | null;

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
   * abort flows into the pin for streaming actions and is a no-op for
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

// ── The common-case matcher ──

/**
 * Build the `frame.type === <type>` matcher — what every route used
 * to write inline. Returns `true` when the inbound envelope's `type`
 * field equals the supplied value, `null` otherwise.
 *
 *   wsData("receive")
 *   wsData("observe-cancel")
 */
export function wsData(type: WebSocketRequest["type"]): WsMatcher {
  return (frame) => frame.type === type ? true : null;
}

// ── Dispatch ──

/**
 * Match `frame` against `routes` by calling each `on(frame)`, run the
 * first that hits, and yield the encoded envelope(s).
 *
 *   every matcher returns null                  → one envelope, `Unknown type`
 *   decode/action/encode throws HttpError       → one envelope, `error` = message
 *   anything else thrown                        → one envelope, `error` = message
 *   `encode` returns undefined                  → no envelope (fire-and-forget)
 *   unary route                                 → one envelope from encode
 *   streaming route (observe)                   → many envelopes from encode
 *
 * The caller pumps each yielded envelope onto the wire.
 */
export async function* dispatchWs(
  pin: ProtocolInterfaceNode,
  routes: readonly WsRoute[],
  frame: WebSocketRequest,
  abort: AbortController,
): AsyncIterable<WebSocketResponse> {
  for (const r of routes) {
    if (r.on(frame) === null) continue;
    const ctx: WsContext = {
      id: frame.id,
      payload: frame.payload,
      abort,
    };
    try {
      const args = await r.decode(ctx);
      const result = await r.action(pin, args, abort.signal);
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
