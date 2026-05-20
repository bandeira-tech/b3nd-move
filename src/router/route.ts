/**
 * @module
 * Transport-agnostic route descriptor.
 *
 * `Route` is the data structure that describes one endpoint as four
 * fields:
 *
 *   on      a matcher of the transport's shape (HTTP method+path, WS
 *           envelope type, MCP tool name, …)
 *   action  the rig method this endpoint targets
 *   decode  ctx → args tuple for the action (or throws on bad input)
 *   encode  (action result, ctx) → wire response
 *
 * The transport-specific bits are the type parameters — `Match` is
 * the matcher shape, `Ctx` is what `decode` and `encode` see for the
 * request side, `Out` is the wire response type. Each transport
 * specialises with its own values; the data structure stays one.
 *
 * Defaults are HTTP-friendly so the common case doesn't have to
 * spell out generics. See `./http.ts` for the HTTP specialisation
 * and the dispatcher.
 */

import type {
  Output,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import type { ActionName } from "../actions/run.ts";
import type { HttpContext, HttpMatcher } from "./http.ts";

/**
 * Args tuple `decode` produces for each rig action. The dispatcher
 * spreads these into the matching rig method; for `observe` it also
 * injects the per-request `AbortSignal`, so decoders don't carry one.
 */
export type ArgsFor<A extends ActionName> = A extends "status" ? readonly []
  : A extends "receive" ? readonly [outputs: Output[]]
  : A extends "read" ? readonly [urls: string[]]
  : A extends "observe" ? readonly [urls: string[]]
  : never;

/**
 * What `encode` receives for each action. Unary actions are awaited
 * before encode runs; observe gets the live `AsyncIterable` so encode
 * can stream it.
 */
export type ResultFor<A extends ActionName> = A extends "status" ? StatusResult
  : A extends "receive" ? ReceiveResult[]
  : A extends "read" ? Output[]
  : A extends "observe" ? AsyncIterable<readonly string[]>
  : never;

/**
 * One endpoint as a declarative record.
 *
 * Parameterised over the four transport-shaped axes:
 *
 *   A      action this endpoint targets (narrows decode/encode types)
 *   Match  matcher shape — `{ method, path }` for HTTP, `{ type }` for WS, …
 *   Ctx    request-side context decode/encode see
 *   Out    wire response type
 *
 * For HTTP the defaults are wired so `Route<"read">` is enough; other
 * transports specialise with their own `Match` / `Ctx` / `Out`.
 */
export interface Route<
  A extends ActionName = ActionName,
  Match = HttpMatcher,
  Ctx = HttpContext,
  Out = Response,
> {
  on: Match;
  action: A;
  decode: (ctx: Ctx) => ArgsFor<A> | Promise<ArgsFor<A>>;
  encode: (result: ResultFor<A>, ctx: Ctx) => Out | Promise<Out>;
}
