/**
 * @module
 * gRPC-HTTP specialisation of the generic `Route` + the dispatcher.
 *
 * The transport-shaped bits live here:
 *
 *   GrpcMatcher  `{ method }` — the suffix after `/b3nd.v1.B3ndService/`
 *   GrpcContext  `{ req, encoding, abort }` — what decode/encode see
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
 * Encoding is a per-request axis in the context: each route's
 * `decode` / `encode` handles both JSON and binary protobuf by
 * branching on `ctx.encoding`. The `observe` route streams NDJSON
 * regardless of encoding (the connectrpc streaming envelope format is
 * not implemented here), so it ignores the field.
 *
 * Routes whose `encode` returns `undefined` (fire-and-forget control
 * frames) render as `204 No Content`.
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import { HttpError, NotFound } from "../../router/errors.ts";
import type { Route } from "../../router/route.ts";

/** Path prefix every B3ndService method shares. */
export const SERVICE_PREFIX = "/b3nd.v1.B3ndService/";

/** Wire encoding picked from the request's `Content-Type` header. */
export type Encoding = "json" | "binary";

/**
 * Internal alias for a gRPC-HTTP-specialised `Route`. Not exported —
 * the public name is the generic `Route`. This just keeps the
 * dispatcher and `route()` signatures from spelling out the five type
 * params at every site.
 */
type GrpcRoute<
  Args extends readonly unknown[] = readonly unknown[],
  Result = unknown,
> = Route<Args, Result, GrpcMatcher, GrpcContext, Response>;

// ── gRPC-HTTP-specific axes of `Route` ──

/** Declarative matcher: the method suffix after `SERVICE_PREFIX`. */
export interface GrpcMatcher {
  /** e.g. `"Receive"`, `"Read"`, `"Observe"`, `"Status"`. */
  method: string;
}

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
 * Walk `routes` against `req`, run the first route whose method
 * matches the path suffix, run the action, and return its encoded
 * Response.
 *
 *   path doesn't start with SERVICE_PREFIX → 404 plain text
 *   method != POST                         → 404 plain text
 *   no route matches the method suffix     → 404 with `{ error }` JSON
 *   decode/action/encode throws HttpError  → status from error, JSON envelope
 *   anything else thrown                   → 500 with `{ error }` JSON
 *   `encode` returns undefined             → 204 No Content
 *   full match                             → run action → encode
 *
 * Errors are wire-adapter concerns (bad body, bad encoding, unknown
 * method) and never reach the rig. Throwing an `HttpError` is the way
 * routes signal them — see `../../router/errors.ts`.
 */
export async function dispatchGrpc(
  rig: Rig,
  routes: readonly GrpcRoute[],
  req: Request,
): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (req.method !== "POST" || !path.startsWith(SERVICE_PREFIX)) {
    return new Response("Not Found", { status: 404 });
  }
  const method = path.slice(SERVICE_PREFIX.length);
  const encoding = detectEncoding(req);

  // Per-request lifecycle. For streaming actions (observe) this is
  // the signal the rig observer sees; for unary it's effectively
  // ignored but still wired so encoders can opt in.
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  req.signal.addEventListener("abort", onAbort, { once: true });

  try {
    for (const r of routes) {
      if (r.on.method !== method) continue;
      const ctx: GrpcContext = { req, encoding, abort };
      try {
        const args = await r.decode(ctx);
        const result = await r.action(rig, args, abort.signal);
        const out = await r.encode(result as Awaited<typeof result>, ctx);
        return out ?? new Response(null, { status: 204 });
      } catch (e) {
        return renderError(e);
      }
    }
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
