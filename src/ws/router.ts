/**
 * @module
 * WebSocket specialisation of the generic `Route` + the dispatcher.
 *
 * The transport-shaped bits live here:
 *
 *   WsMatcher    `{ type }` — matches a single envelope `type` value
 *   WsContext    `{ id, payload, abort }` — what decode/encode see
 *   route<A>()   constructor that preserves action narrowing
 *   dispatchWs   matches one inbound frame, runs the action, yields
 *                one or more outbound envelopes
 *
 * The data structure itself (`Route`, `ArgsFor`, `ResultFor`) lives in
 * `../router/route.ts` and is transport-agnostic. Wire-adapter errors
 * live in `../router/errors.ts`; their `status` is mapped here into the
 * `error` field of the envelope — WS doesn't carry an HTTP status, but
 * the dispatcher still uses the shared taxonomy so transports stay in
 * sync on what counts as a 400 vs. 500.
 *
 * `observe-cancel` is intentionally **not** a route. It's a control
 * frame that operates on the per-socket lifecycle (the `observes` map
 * the service owns), so the service handles it before reaching the
 * route table.
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import {
  type ActionName,
  makeActionCall,
  runAction,
} from "../actions/run.ts";
import { HttpError } from "../router/errors.ts";
import type { Route } from "../router/route.ts";
import type { WebSocketRequest, WebSocketResponse } from "./client.ts";

/**
 * Internal alias for a WS-specialised `Route`. Not exported — the
 * public name is the generic `Route`. This just keeps the dispatcher
 * and `route()` signatures from spelling out the four type params at
 * every site.
 *
 * `Out` is a union so observe can return an `AsyncIterable` of envelope
 * frames (one per fired batch + a terminator) while unary actions
 * return a single envelope.
 */
type WsRoute<A extends ActionName = ActionName> = Route<
  A,
  WsMatcher,
  WsContext,
  WebSocketResponse | AsyncIterable<WebSocketResponse>
>;

// ── WS-specific axes of `Route` ──

/** Declarative matcher: the inbound envelope's `type` value. */
export interface WsMatcher {
  type: ActionName;
}

/** Per-frame context handed to `decode` and `encode`. */
export interface WsContext {
  /** Correlation id from the inbound envelope — copy onto every outbound. */
  id: string;
  /** Raw `payload` field from the inbound envelope; route owns its shape. */
  payload: unknown;
  /**
   * Per-frame abort. The service registers this in its socket-level
   * `observes` map so an `observe-cancel` frame with the same `id` can
   * fire it; the abort flows into the rig for streaming actions and is
   * a no-op for unary ones.
   */
  abort: AbortController;
}

/**
 * Type-preserving WS route constructor. Use this so `decode`'s args
 * and `encode`'s result narrow from the literal `action`.
 *
 * The return is erased to `Route` so heterogeneous routes share a
 * single table type.
 */
export function route<A extends ActionName>(r: WsRoute<A>): WsRoute {
  return r as WsRoute;
}

// ── Dispatch ──

/**
 * Match `frame` against `routes`, run the first route whose `type`
 * matches, run the action, and yield the encoded envelope(s).
 *
 *   no matching type                       → one envelope, `Unknown type`
 *   decode/encode throws HttpError         → one envelope, `error` = message
 *   decode/encode throws anything else     → one envelope, `error` = message
 *   unary route                            → one envelope from encode
 *   streaming route (observe)              → many envelopes from encode
 *
 * The caller wires `abort` to the per-frame slot in the socket's
 * `observes` map and pumps each yielded envelope onto the wire.
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
      const call = makeActionCall(r.action, args, abort.signal);
      const result = await runAction(rig, call);
      // The action discriminant guarantees result matches the route's
      // ResultFor<A>, but TS can't carry that across the existential
      // erasure in the heterogeneous routes array.
      const out = await r.encode(result as never, ctx);
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
