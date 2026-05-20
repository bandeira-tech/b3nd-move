/**
 * @module
 * HTTP route descriptor + dispatcher.
 *
 * A `HttpRoute` declares one HTTP endpoint as four fields:
 *
 *   on      declarative matcher — method + path pattern
 *   action  which rig method this endpoint targets
 *   decode  (req, params) → args for the rig method (or Response on bail)
 *   encode  (result, ctx) → wire Response
 *
 * `path` patterns support `:name` placeholders captured into `params`.
 * The dispatcher walks the table, runs the action, and hands the result
 * to `encode`. Streaming actions (observe) return an AsyncIterable
 * directly to encode; helpers like `ndjsonResponse` turn that into a
 * Response without each route writing ReadableStream code.
 *
 * `405 Method Not Allowed` is emitted automatically when the path
 * matches some route but its method doesn't — `Allow:` header is the
 * union of methods from all path-matching routes.
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import type { ActionName } from "../actions/run.ts";

/** Declarative matcher: method + path-with-`:params`. */
export interface HttpMatcher {
  /** Single method or a list. Used both for match and the `Allow:` header. */
  method: string | readonly string[];
  /**
   * Path pattern. Exact-match by default; `:name` segments capture
   * one URL segment into `params[name]` (empty captures don't
   * match — `/foo/` doesn't match `/foo/:x`).
   */
  path: string;
}

/** Path params extracted from `:name` placeholders in the pattern. */
export type PathParams = Record<string, string>;

/**
 * Arguments `decode` produces for each rig action. The dispatcher
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
 * before encode runs; observe gets the live AsyncIterable so encode
 * can stream it (typically via `ndjsonResponse(frames, ctx.abort)`).
 */
export type ResultFor<A extends ActionName> = A extends "status" ? StatusResult
  : A extends "receive" ? ReceiveResult[]
  : A extends "read" ? Output[]
  : A extends "observe" ? AsyncIterable<readonly string[]>
  : never;

/** Per-request context handed to `encode`. */
export interface RouteContext {
  /** The original Request — useful for content negotiation, custom headers, etc. */
  req: Request;
  /**
   * Per-request abort. Cancelled when the request signal fires; cancel
   * it from within a streaming encoder when the consumer disconnects
   * (see `ndjsonResponse`).
   */
  abort: AbortController;
}

/**
 * One HTTP endpoint as a declarative record.
 *
 * Routes are walked in order. The first whose `on` matches the
 * request runs; later ones are ignored. Put more specific paths
 * before less specific ones if they could overlap.
 */
export interface HttpRoute<A extends ActionName = ActionName> {
  /** Declarative matcher: method + path. */
  on: HttpMatcher;
  /** The rig action this endpoint targets. */
  action: A;
  /**
   * Build the args tuple from the matched request. Throw → 500.
   * Return a `Response` to short-circuit — use this for validation
   * failures so each route owns its 400 envelope shape.
   */
  decode: (
    req: Request,
    params: PathParams,
  ) => ArgsFor<A> | Response | Promise<ArgsFor<A> | Response>;
  /**
   * Turn the rig's result into the wire response. For streaming
   * actions (`observe`) the result is an `AsyncIterable` — hand it
   * to `ndjsonResponse(frames, ctx.abort)` (or your own stream helper).
   */
  encode: (
    result: ResultFor<A>,
    ctx: RouteContext,
  ) => Response | Promise<Response>;
}

/**
 * Type-preserving route constructor. Use this so `decode`'s args and
 * `encode`'s result narrow from the literal `action`:
 *
 *   route({
 *     on: { method: "GET", path: "/api/v1/status" },
 *     action: "status",
 *     decode: () => [],                  // narrowed to ArgsFor<"status">
 *     encode: (r) => json(r, ...),       // r: StatusResult
 *   })
 *
 * The return is erased to `HttpRoute` so heterogeneous routes share a
 * single table type.
 */
export function route<A extends ActionName>(r: HttpRoute<A>): HttpRoute {
  return r as unknown as HttpRoute;
}

// ── Matcher compilation ──

interface Compiled {
  methods: readonly string[];
  match: (path: string) => PathParams | null;
}

function methodList(m: HttpMatcher["method"]): readonly string[] {
  return typeof m === "string" ? [m] : m;
}

function compile(matcher: HttpMatcher): Compiled {
  const segments = matcher.path.split("/");
  return {
    methods: methodList(matcher.method),
    match(path: string): PathParams | null {
      const ps = path.split("/");
      if (ps.length !== segments.length) return null;
      const params: PathParams = {};
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.startsWith(":")) {
          // Strict: `:param` requires a non-empty capture so trailing
          // slashes (`/foo/`) don't accidentally match `/foo/:x`.
          if (ps[i] === "") return null;
          params[seg.slice(1)] = ps[i];
        } else if (seg !== ps[i]) {
          return null;
        }
      }
      return params;
    },
  };
}

// ── Dispatch ──

/**
 * Walk `routes` against `req`, run the first whose method + path
 * match, run the action, and return its `encode` response.
 *
 *   path doesn't match anything           → 404
 *   path matches but no method does       → 405 with `Allow:` union
 *   decode returns Response               → short-circuits
 *   full match                            → run action → encode
 */
export async function dispatchHttp(
  rig: Rig,
  routes: readonly HttpRoute[],
  req: Request,
): Promise<Response> {
  const path = new URL(req.url).pathname;
  const allowed = new Set<string>();

  for (const route of routes) {
    const c = compile(route.on);
    const params = c.match(path);
    if (params === null) continue;
    if (!c.methods.includes(req.method)) {
      for (const m of c.methods) allowed.add(m);
      continue;
    }

    // Per-request lifecycle. For streaming actions (observe) this is
    // the signal the rig observer sees; for unary it's effectively
    // ignored but still wired so encoders can opt in.
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    req.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const args = await route.decode(req, params);
      if (args instanceof Response) return args;

      const result = await execute(rig, route.action, args, abort.signal);
      // The action discriminant guarantees result matches `route`'s
      // ResultFor<A>, but TS can't carry that across the existential
      // erasure in the heterogeneous routes array.
      return await route.encode(result as never, { req, abort });
    } finally {
      req.signal.removeEventListener("abort", onAbort);
    }
  }

  if (allowed.size > 0) {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: [...allowed].join(", ") },
    });
  }
  return new Response("Not Found", { status: 404 });
}

/**
 * Dispatch the rig method for an action. Unary actions are awaited so
 * `encode` sees the unwrapped result; observe returns the live
 * AsyncIterable so encoders can stream it.
 */
async function execute(
  rig: Rig,
  action: ActionName,
  args: readonly unknown[],
  signal: AbortSignal,
): Promise<unknown> {
  switch (action) {
    case "status":
      return await rig.status();
    case "receive":
      return await rig.receive(args[0] as Output[]);
    case "read":
      return await rig.read(args[0] as string[]);
    case "observe":
      return rig.observe(args[0] as string[], signal);
  }
}
