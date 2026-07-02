/**
 * @module
 * gRPC-HTTP specialisation of the generic `Route` + the dispatcher.
 *
 * The transport-shaped bits live here:
 *
 *   GrpcMatcher  `(req) => true | null` — function over the raw
 *                Request; matcher decides whether this route handles it
 *   GrpcContext  `{ req, encoding, abort }` — what decode/encode see
 *   grpcMethod   helper that builds the common
 *                `path === SERVICE_PREFIX + <method>` matcher
 *   route()      constructor that infers Args/Result from the action fn
 *   dispatchGrpc gates SERVICE_PREFIX + POST, picks encoding from
 *                Content-Type, runs the table, renders errors as
 *                `{ "error": message }` JSON
 *
 * The data structure itself (`Route`, `Action`) lives in
 * `../../router/route.ts` and is transport-agnostic. Wire-adapter
 * errors live in `../../router/errors.ts`; their `status` maps onto
 * the HTTP response status here, with the message in the JSON envelope.
 *
 * `on` is a function over the request primitive, not a declarative
 * struct: the matcher owns parsing the URL. The dispatcher just
 * calls it. The win is composability — a route can match on any
 * property of the Request (header, custom path scheme) by supplying
 * its own function, without growing the struct the dispatcher knows
 * about. The common case is built with `grpcMethod(name)`.
 *
 * Encoding is a per-request axis in the context: each route's
 * `decode` / `encode` handles both JSON and binary protobuf by
 * branching on `ctx.encoding`. The `observe` route streams NDJSON
 * regardless of encoding (the connectrpc streaming envelope format is
 * not implemented here), so it ignores the field.
 *
 * Routes whose `encode` returns `undefined` (fire-and-forget control
 * frames) render as `204 No Content`.
 */

import type { ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core/types";
import { HttpError, NotFound } from "../../router/errors.ts";
import type { Route } from "../../router/route.ts";

/** Path prefix every B3ndService method shares. */
export const SERVICE_PREFIX = "/b3nd.v1.B3ndService/";

/** Wire encoding picked from the request's `Content-Type` header. */
export type Encoding = "json" | "binary";

/**
 * gRPC-HTTP-specialised `Route`. Exported so route factory functions
 * (e.g. `readRoute(codec)`, `receiveRoute(codec)`) can annotate their
 * return types without spelling out all five type params.
 */
export type GrpcRoute<
  Args extends readonly unknown[] = readonly unknown[],
  Result = unknown,
> = Route<Args, Result, GrpcMatcher, GrpcContext, Response>;

// ── gRPC-HTTP-specific axes of `Route` ──

/**
 * Matcher function. Operates on the raw `Request` — no pre-parsing
 * by the dispatcher beyond the upstream SERVICE_PREFIX + POST gate —
 * and returns `true` on a match, `null` to skip.
 */
export type GrpcMatcher = (req: Request) => true | null;

/** Per-request context handed to `decode` and `encode`. */
export interface GrpcContext {
  /** The original Request. */
  req: Request;
  /** Wire encoding negotiated from Content-Type. */
  encoding: Encoding;
  /**
   * Per-request abort. Cancelled when the request signal fires;
   * cancel it from within a streaming encoder when the consumer
   * disconnects (see `ndjsonResponse`).
   */
  abort: AbortController;
}

/**
 * Type-preserving gRPC-HTTP route constructor. Infers `Args`/`Result`
 * from the supplied `action` so `decode`'s tuple and `encode`'s input
 * narrow automatically.
 *
 * The return is erased to the default `GrpcRoute` so heterogeneous
 * routes share a single table type.
 */
export function route<Args extends readonly unknown[], Result>(
  r: GrpcRoute<Args, Result>,
): GrpcRoute {
  // Erase Args/Result to the heterogeneous-table type. The dispatcher
  // re-narrows per-route via the action's runtime closure.
  return r as unknown as GrpcRoute;
}

// ── The common-case matcher ──

/**
 * Build the `path === SERVICE_PREFIX + <method>` matcher — what every
 * route used to write inline. `method` is the bare RPC name, e.g.
 * `"Receive"`, `"Read"`, `"Observe"`, `"Status"`.
 *
 *   grpcMethod("Receive")
 *   grpcMethod("Status")
 *
 * The dispatcher pre-gates `POST` + `SERVICE_PREFIX`; matchers only
 * need to discriminate by method suffix.
 */
export function grpcMethod(method: string): GrpcMatcher {
  const expected = SERVICE_PREFIX + method;
  return (req) => new URL(req.url).pathname === expected ? true : null;
}

// ── Encoding ──

/**
 * Negotiate wire encoding from the request's `Content-Type`. Defaults
 * to JSON for anything we don't recognise, matching the historic
 * gRPC-HTTP service behaviour.
 */
export function detectEncoding(req: Request): Encoding {
  const ct = req.headers.get("content-type") ?? "";
  if (
    ct.startsWith("application/connect+proto") ||
    ct.startsWith("application/proto") ||
    ct.startsWith("application/grpc")
  ) return "binary";
  return "json";
}

// ── Dispatch ──

/**
 * Walk `routes` against `req`, call each `on(req)`, and run the first
 * route that hits.
 *
 *   path doesn't start with SERVICE_PREFIX → 404 plain text
 *   method != POST                         → 404 plain text
 *   every matcher returns null             → 404 with `{ error }` JSON
 *   decode/action/encode throws HttpError  → status from error, JSON envelope
 *   anything else thrown                   → 500 with `{ error }` JSON
 *   `encode` returns undefined             → 204 No Content
 *   first matching route                   → run action → encode
 *
 * Errors are wire-adapter concerns (bad body, bad encoding, unknown
 * method) and never reach the pin. Throwing an `HttpError` is the way
 * routes signal them — see `../../router/errors.ts`.
 */
export async function dispatchGrpc(
  pin: ProtocolInterfaceNode,
  routes: readonly GrpcRoute[],
  req: Request,
): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (req.method !== "POST" || !path.startsWith(SERVICE_PREFIX)) {
    return new Response("Not Found", { status: 404 });
  }
  const encoding = detectEncoding(req);

  // Per-request lifecycle. For streaming actions (observe) this is
  // the signal the pin observer sees; for unary it's effectively
  // ignored but still wired so encoders can opt in.
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  req.signal.addEventListener("abort", onAbort, { once: true });

  try {
    for (const r of routes) {
      if (r.on(req) === null) continue;
      const ctx: GrpcContext = { req, encoding, abort };
      try {
        const args = await r.decode(ctx);
        const result = await r.action(pin, args, abort.signal);
        const out = await r.encode(result as Awaited<typeof result>, ctx);
        return out ?? new Response(null, { status: 204 });
      } catch (e) {
        return renderError(e);
      }
    }
    const method = path.slice(SERVICE_PREFIX.length);
    return renderError(new NotFound(`Unknown method: ${method}`));
  } finally {
    req.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * gRPC-HTTP error rendering. Status carries the category (mapped from
 * the shared `HttpError` taxonomy); body is a `{ "error": message }`
 * JSON envelope — what the existing gRPC-HTTP clients already parse.
 */
function renderError(e: unknown): Response {
  const status = e instanceof HttpError ? e.status : 500;
  const message = e instanceof Error ? e.message : String(e);
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
