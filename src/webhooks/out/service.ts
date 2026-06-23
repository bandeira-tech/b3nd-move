/**
 * @module
 * Webhooks **out** — the subscription API.
 *
 * Lets external consumers register a callback URL and have `observe` /
 * `read` results *pushed* there, instead of holding an NDJSON stream open
 * (`observe`) or polling (`read`). This is the HTTP front end over the
 * `./bridge.ts` engine and `./sender.ts` delivery primitive.
 *
 *   POST   /api/v1/webhooks/out/subscriptions   { url, urls, secret?, hydrate? }
 *            → 201 { id, url, urls, hydrate, createdAt }
 *            starts a background observe→deliver loop
 *   GET    /api/v1/webhooks/out/subscriptions
 *            → 200 [ Subscription, … ]
 *   DELETE /api/v1/webhooks/out/subscriptions/:id
 *            → 204  (404 if unknown)  — aborts the loop
 *   POST   /api/v1/webhooks/out/read            { url, urls, secret? }
 *            → 200 { delivered: DeliveryResult }   one-shot read push
 *
 * Active subscriptions live in a {@link SubscriptionRegistry}. The
 * default `memoryRegistry()` is per-handler and in-process — a real
 * deployment with restarts / multiple instances supplies its own backed
 * by durable storage. Hosts hold the registry to `closeAll()` on
 * shutdown; the move layer never owns a process lifecycle.
 *
 * @example
 * ```ts
 * import { webhooksOutApi, memoryRegistry }
 *   from "@bandeira-tech/b3nd-move/webhooks/out/service";
 *
 * const registry = memoryRegistry();
 * Deno.serve({ port: 3000 }, webhooksOutApi(rig, { registry }));
 * // on shutdown: registry.closeAll();
 * ```
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import { BadRequest, NotFound } from "../../router/errors.ts";
import { dispatchHttp, httpRequest, route } from "../../http/router.ts";
import { json, readJson } from "../../http/wire.ts";
import {
  createWebhookSender,
  type WebhookSender,
  type WebhookSenderConfig,
} from "./sender.ts";
import { observeToWebhook, readToWebhook } from "./bridge.ts";

// ── Subscription model ──

/** Public view of a registered subscription. */
export interface Subscription {
  id: string;
  /** Delivery URL. */
  url: string;
  /** Observed locators. */
  urls: string[];
  /** Whether each delivery is hydrated with read outputs. */
  hydrate: boolean;
  /** ISO timestamp of registration. */
  createdAt: string;
}

/**
 * Holds active subscriptions and their abort handles. Swap the default
 * `memoryRegistry()` for a durable implementation in multi-instance
 * deployments.
 */
export interface SubscriptionRegistry {
  add(sub: Subscription, controller: AbortController): void;
  list(): Subscription[];
  /** Abort + drop a subscription. Returns whether it existed. */
  remove(id: string): boolean;
  /** Abort + drop every subscription (host shutdown). */
  closeAll(): void;
}

/** Default in-process, in-memory registry. */
export function memoryRegistry(): SubscriptionRegistry {
  const entries = new Map<
    string,
    { sub: Subscription; controller: AbortController }
  >();
  return {
    add(sub, controller) {
      entries.set(sub.id, { sub, controller });
    },
    list() {
      return [...entries.values()].map((e) => e.sub);
    },
    remove(id) {
      const entry = entries.get(id);
      if (!entry) return false;
      entry.controller.abort();
      entries.delete(id);
      return true;
    },
    closeAll() {
      for (const { controller } of entries.values()) controller.abort();
      entries.clear();
    },
  };
}

// ── Options ──

/** Sender knobs shared by every subscription (timeout, retries, …). */
export type SenderDefaults = Omit<WebhookSenderConfig, "url" | "secret">;

export interface WebhooksOutApiOptions {
  /** Active-subscription store. Default: a fresh `memoryRegistry()`. */
  registry?: SubscriptionRegistry;
  /** Defaults applied to every sender built for a subscription. */
  senderDefaults?: SenderDefaults;
  /** Override the sender factory (tests / custom delivery). */
  createSender?: (config: WebhookSenderConfig) => WebhookSender;
}

// ── Request body parsing ──

interface SubscribeBody {
  url: string;
  urls: string[];
  secret?: string;
  hydrate?: boolean;
}

function parseSubscribe(body: unknown): SubscribeBody {
  if (typeof body !== "object" || body === null) {
    throw new BadRequest("Body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.url !== "string" || b.url.length === 0) {
    throw new BadRequest("`url` (string) is required");
  }
  if (
    !Array.isArray(b.urls) || b.urls.length === 0 ||
    !b.urls.every((u) => typeof u === "string")
  ) {
    throw new BadRequest("`urls` (non-empty string[]) is required");
  }
  if (b.secret !== undefined && typeof b.secret !== "string") {
    throw new BadRequest("`secret` must be a string");
  }
  if (b.hydrate !== undefined && typeof b.hydrate !== "boolean") {
    throw new BadRequest("`hydrate` must be a boolean");
  }
  return {
    url: b.url,
    urls: b.urls as string[],
    secret: b.secret as string | undefined,
    hydrate: b.hydrate as boolean | undefined,
  };
}

// ── Routes ──

/**
 * Build the outbound route table over a registry + sender factory.
 * Exported so the combined `webhooksApi` can merge it with the inbound
 * routes into a single dispatch.
 */
export function webhooksOutRoutes(
  options: WebhooksOutApiOptions = {},
): Array<ReturnType<typeof route>> {
  const registry = options.registry ?? memoryRegistry();
  const senderDefaults = options.senderDefaults ?? {};
  const makeSender = options.createSender ?? createWebhookSender;

  const senderFor = (url: string, secret?: string): WebhookSender =>
    makeSender({ ...senderDefaults, url, secret });

  const subscribe = route({
    on: httpRequest("POST", "/api/v1/webhooks/out/subscriptions"),
    decode: async ({ req }) => [parseSubscribe(await readJson(req))] as const,
    action: (rig: Rig, [body]: readonly [SubscribeBody]) => {
      const id = crypto.randomUUID();
      const sub: Subscription = {
        id,
        url: body.url,
        urls: body.urls,
        hydrate: body.hydrate ?? false,
        createdAt: new Date().toISOString(),
      };
      const controller = new AbortController();
      registry.add(sub, controller);
      const sender = senderFor(body.url, body.secret);
      // Detached: the loop outlives this request and is torn down via
      // the registry's controller. Self-cleans on natural end so a
      // finite observe stream doesn't leave a dead entry behind.
      observeToWebhook(rig, body.urls, sender, controller.signal, {
        hydrate: sub.hydrate,
      })
        .catch(() => {})
        .finally(() => registry.remove(id));
      return sub;
    },
    encode: (sub: Subscription) => json(sub, 201),
  });

  const list = route({
    on: httpRequest("GET", "/api/v1/webhooks/out/subscriptions"),
    decode: () => [] as const,
    action: () => registry.list(),
    encode: (subs: Subscription[]) => json(subs, 200),
  });

  const remove = route({
    on: httpRequest("DELETE", "/api/v1/webhooks/out/subscriptions/:id"),
    decode: ({ params }) => [params.id] as const,
    action: (_rig: Rig, [id]: readonly [string]) => registry.remove(id),
    encode: (removed: boolean) => {
      if (!removed) throw new NotFound("Unknown subscription");
      return undefined; // 204
    },
  });

  const readPush = route({
    on: httpRequest("POST", "/api/v1/webhooks/out/read"),
    decode: async ({ req }) => [parseSubscribe(await readJson(req))] as const,
    action: (rig: Rig, [body]: readonly [SubscribeBody]) =>
      readToWebhook(rig, body.urls, senderFor(body.url, body.secret)),
    encode: (delivered) => json({ delivered }, 200),
  });

  return [subscribe, list, remove, readPush];
}

/**
 * Create an outbound-webhook subscription HTTP handler backed by a Rig.
 * Returns a standard `(Request) => Promise<Response>`.
 */
export function webhooksOutApi(
  rig: Rig,
  options: WebhooksOutApiOptions = {},
): (req: Request) => Promise<Response> {
  const routes = webhooksOutRoutes(options);
  return (req) => dispatchHttp(rig, routes, req);
}
