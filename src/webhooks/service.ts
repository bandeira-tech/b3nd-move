/**
 * @module
 * Webhooks — both directions behind one handler.
 *
 * `webhooksApi(rig, { in, out })` merges the inbound delivery routes
 * (`./in/service.ts`) and the outbound subscription routes
 * (`./out/service.ts`) into a single dispatch table, so one
 * `(Request) => Promise<Response>` serves the whole external-HTTP
 * cooperation surface:
 *
 *   POST   /api/v1/webhooks/in/:source            ← senders deliver in
 *   POST   /api/v1/webhooks/out/subscriptions     → results pushed out
 *   GET    /api/v1/webhooks/out/subscriptions
 *   DELETE /api/v1/webhooks/out/subscriptions/:id
 *   POST   /api/v1/webhooks/out/read
 *
 * The `in/` and `out/` route prefixes never collide, so the order of the
 * merged table is irrelevant. Use the per-direction `webhooksInApi` /
 * `webhooksOutApi` when a deployment only needs one half.
 *
 * @example
 * ```ts
 * import { webhooksApi } from "@bandeira-tech/b3nd-move/webhooks/service";
 * import { verify, decode } from "@bandeira-tech/b3nd-move/webhooks/in/source";
 * import { memoryRegistry } from "@bandeira-tech/b3nd-move/webhooks/out/service";
 *
 * const registry = memoryRegistry();
 * Deno.serve({ port: 3000 }, webhooksApi(rig, {
 *   in: { sources: { partner: { verify: verify.hmacSha256({ secret }), decode: … } } },
 *   out: { registry },
 * }));
 * ```
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import { dispatchHttp } from "../http/router.ts";
import { type WebhooksInApiOptions, webhooksInRoutes } from "./in/service.ts";
import {
  type WebhooksOutApiOptions,
  webhooksOutRoutes,
} from "./out/service.ts";

export interface WebhooksApiOptions {
  /** Inbound delivery sources. Omit to serve only the outbound half. */
  in?: WebhooksInApiOptions;
  /** Outbound subscription options. Omit to serve only the inbound half. */
  out?: WebhooksOutApiOptions;
}

/**
 * Create a combined inbound + outbound webhooks handler backed by a Rig.
 */
export function webhooksApi(
  rig: Rig,
  options: WebhooksApiOptions = {},
): (req: Request) => Promise<Response> {
  const routes = [
    ...(options.in ? webhooksInRoutes(options.in) : []),
    ...(options.out ? webhooksOutRoutes(options.out) : []),
  ];
  return (req) => dispatchHttp(rig, routes, req);
}
