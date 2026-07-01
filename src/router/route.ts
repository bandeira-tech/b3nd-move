/**
 * @module
 * Transport-agnostic route descriptor.
 *
 * `Route` is the data structure that describes one endpoint as four
 * fields:
 *
 *   on      a matcher of the transport's shape (HTTP method+path, WS
 *           envelope type, MCP tool name, …)
 *   decode  ctx → args tuple for the action (or throws on bad input)
 *   action  the function that does the work — `(rig, args, signal) → result`
 *   encode  (action result, ctx) → wire response, or `undefined` for none
 *
 * The transport-shaped bits are the type parameters — `Match` is the
 * matcher shape, `Ctx` is what `decode` and `encode` see, `Out` is the
 * wire response type. Each transport specialises with its own values;
 * the data structure stays one.
 *
 * `action` is a function, not a label. The standard set
 * (`statusAction`, `receiveAction`, `readAction`, `observeAction`) is
 * exported from `../actions/standard.ts`; custom routes supply their
 * own function — observe-cancel is the canonical example, an action
 * that operates on transport state (a per-socket abort registry)
 * rather than on the rig.
 *
 * `encode` may return `undefined` to mean "no wire response" — useful
 * for fire-and-forget control frames like observe-cancel. Each
 * dispatcher decides how to render the empty: WS sends nothing,
 * HTTP/gRPC emit 204 No Content.
 *
 * No defaults — the generic stays neutral. Transport modules (see
 * `../http/router.ts`) define their own specialisation alias and
 * export the `route()` constructor that pins the generics for that
 * transport.
 */

import type { ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core/types";

/**
 * Action function: `(rig, args, signal) → result`. Standard ones bind
 * rig methods; custom ones (observe-cancel, fire-and-forget control
 * frames, …) can ignore `rig` / `signal` entirely. The signal is the
 * dispatcher's per-request `AbortController.signal`.
 */
export type Action<Args extends readonly unknown[], Result> = (
  rig: ProtocolInterfaceNode,
  args: Args,
  signal: AbortSignal,
) => Result | Promise<Result>;

/**
 * One endpoint as a declarative record.
 *
 * Parameterised over five axes:
 *
 *   Args   tuple `decode` produces and `action` consumes
 *   Result what `action` returns (Promise / AsyncIterable / value)
 *   Match  matcher shape — `{ method, path }` for HTTP, `{ type }` for WS, …
 *   Ctx    request-side context decode/encode see
 *   Out    wire response type
 *
 * Transport modules pin `Match`, `Ctx`, `Out` for their
 * specialisation — see `../http/router.ts`.
 */
export interface Route<
  Args extends readonly unknown[],
  Result,
  Match,
  Ctx,
  Out,
> {
  on: Match;
  decode: (ctx: Ctx) => Args | Promise<Args>;
  action: Action<Args, Result>;
  /**
   * `encode` may return `undefined` for routes that don't reply (the
   * observe-cancel control frame, fire-and-forget hooks). The
   * dispatcher renders the empty per transport.
   */
  encode: (
    result: Awaited<Result>,
    ctx: Ctx,
  ) => Out | Promise<Out> | undefined | Promise<undefined>;
}
