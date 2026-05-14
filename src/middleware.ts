/**
 * @module
 * Client middleware — one composable surface across HTTP, WebSocket, and
 * gRPC-HTTP clients.
 *
 * Three hooks, one per lifecycle phase:
 *
 *   - `onConnect`  — runs once during WS handshake. Mutate the URL or
 *                    add subprotocols before the socket opens.
 *   - `onRequest`  — runs before every outbound HTTP / gRPC-HTTP call.
 *                    Mutate headers, body, or URL.
 *   - `onSend`     — runs before every outbound WS frame. Mutate the
 *                    envelope (e.g. sign or add a nonce).
 *
 * Each hook is optional; pick the ones you need. Middleware run in order,
 * sequentially, and may be async.
 *
 * @example
 * ```typescript
 * import { bearer } from "@bandeira-tech/b3nd-move/middleware";
 * import { HttpClient } from "@bandeira-tech/b3nd-move/http/client";
 *
 * const client = new HttpClient({
 *   url: "http://localhost:3000",
 *   middleware: [bearer(() => store.getToken())],
 * });
 * ```
 */

export type MaybePromise<T> = T | Promise<T>;

/** Handshake context — WebSocket only. Mutate `url` or `subprotocols`. */
export interface ConnectContext {
  readonly transport: "ws";
  url: URL;
  subprotocols: string[];
}

/** Per-call context for HTTP and gRPC-HTTP. Mutate `headers`, `url`, or `body`. */
export interface RequestContext {
  readonly transport: "http" | "grpc-http";
  url: URL;
  headers: Headers;
  body: BodyInit | null;
}

/** Per-frame context — WebSocket only. Mutate the envelope object in place. */
export interface SendContext {
  readonly transport: "ws";
  envelope: Record<string, unknown>;
}

/**
 * A composable client interceptor. Implement any subset of the hooks.
 * Run order is the order in the `middleware` array.
 */
export interface ClientMiddleware {
  onConnect?(ctx: ConnectContext): MaybePromise<void>;
  onRequest?(ctx: RequestContext): MaybePromise<void>;
  onSend?(ctx: SendContext): MaybePromise<void>;
}

/** Run every `onConnect` in order. No-op when middleware is undefined. */
export async function runConnect(
  middleware: ClientMiddleware[] | undefined,
  ctx: ConnectContext,
): Promise<void> {
  if (!middleware) return;
  for (const m of middleware) {
    if (m.onConnect) await m.onConnect(ctx);
  }
}

/** Run every `onRequest` in order. No-op when middleware is undefined. */
export async function runRequest(
  middleware: ClientMiddleware[] | undefined,
  ctx: RequestContext,
): Promise<void> {
  if (!middleware) return;
  for (const m of middleware) {
    if (m.onRequest) await m.onRequest(ctx);
  }
}

/** Run every `onSend` in order. No-op when middleware is undefined. */
export async function runSend(
  middleware: ClientMiddleware[] | undefined,
  ctx: SendContext,
): Promise<void> {
  if (!middleware) return;
  for (const m of middleware) {
    if (m.onSend) await m.onSend(ctx);
  }
}

// ─── Canon helpers ────────────────────────────────────────────────────────

type Getter<T> = T | (() => MaybePromise<T>);

async function resolve<T>(g: Getter<T>): Promise<T> {
  return typeof g === "function" ? await (g as () => MaybePromise<T>)() : g;
}

function encodeBasic(user: string, pass: string): string {
  // btoa is available in browsers, Deno, Bun, Node 18+.
  return btoa(`${user}:${pass}`);
}

/**
 * Bearer token auth.
 *
 * - HTTP / gRPC-HTTP: sets `Authorization: Bearer <token>`.
 * - WebSocket: appends `?token=<token>` to the handshake URL. Browser
 *   `WebSocket` cannot send headers, so the query parameter is the
 *   portable fallback. Use {@link subprotocol} if your server expects
 *   it as a subprotocol instead.
 */
export function bearer(token: Getter<string>): ClientMiddleware {
  return {
    async onRequest(ctx) {
      ctx.headers.set("Authorization", `Bearer ${await resolve(token)}`);
    },
    async onConnect(ctx) {
      ctx.url.searchParams.set("token", await resolve(token));
    },
  };
}

/**
 * HTTP Basic auth.
 *
 * - HTTP / gRPC-HTTP: sets `Authorization: Basic <base64>`.
 * - WebSocket: encodes credentials in the URL (`ws://user:pass@host/...`).
 */
export function basic(
  username: Getter<string>,
  password: Getter<string>,
): ClientMiddleware {
  return {
    async onRequest(ctx) {
      const u = await resolve(username);
      const p = await resolve(password);
      ctx.headers.set("Authorization", `Basic ${encodeBasic(u, p)}`);
    },
    async onConnect(ctx) {
      ctx.url.username = await resolve(username);
      ctx.url.password = await resolve(password);
    },
  };
}

/**
 * Set an arbitrary header. HTTP / gRPC-HTTP only — browser `WebSocket`
 * cannot send custom headers, so this is a no-op on WS handshake.
 */
export function header(
  name: string,
  value: Getter<string>,
): ClientMiddleware {
  return {
    async onRequest(ctx) {
      ctx.headers.set(name, await resolve(value));
    },
  };
}

/**
 * Append a URL query parameter. Works on every transport — set on the
 * request URL for HTTP / gRPC-HTTP, on the handshake URL for WS.
 */
export function query(
  name: string,
  value: Getter<string>,
): ClientMiddleware {
  return {
    async onRequest(ctx) {
      ctx.url.searchParams.set(name, await resolve(value));
    },
    async onConnect(ctx) {
      ctx.url.searchParams.set(name, await resolve(value));
    },
  };
}

/**
 * Add a WebSocket subprotocol to the handshake. WS-only. Useful when the
 * server reads auth from the `Sec-WebSocket-Protocol` header (a common
 * workaround for the browser no-custom-headers limitation).
 */
export function subprotocol(name: Getter<string>): ClientMiddleware {
  return {
    async onConnect(ctx) {
      ctx.subprotocols.push(await resolve(name));
    },
  };
}

/** Where to place the API key. */
export interface ApiKeyOptions {
  /** `"header"` (default) sets a header; `"query"` appends a URL param. */
  in?: "header" | "query";
  /** Header or query parameter name. Default: `"X-API-Key"` / `"api_key"`. */
  name?: string;
}

/**
 * API key auth. Defaults to `X-API-Key` header. Pass `{ in: "query" }`
 * to send as a URL parameter instead — that variant works on every
 * transport including WS handshake.
 */
export function apiKey(
  key: Getter<string>,
  options: ApiKeyOptions = {},
): ClientMiddleware {
  const where = options.in ?? "header";
  if (where === "query") {
    return query(options.name ?? "api_key", key);
  }
  return header(options.name ?? "X-API-Key", key);
}

/**
 * Sign every outbound WebSocket envelope. WS-only. The signer receives
 * the envelope and mutates it (typically adding `sig`, `nonce`, `ts`,
 * etc.). For per-call HTTP signing, write a custom `onRequest`.
 */
export function signEnvelope(
  signer: (envelope: Record<string, unknown>) => MaybePromise<void>,
): ClientMiddleware {
  return {
    async onSend(ctx) {
      await signer(ctx.envelope);
    },
  };
}
