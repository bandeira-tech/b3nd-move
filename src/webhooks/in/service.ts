/**
 * @module
 * Webhooks **in** — inbound HTTP cooperation.
 *
 * External senders POST delivery requests; each is verified, decoded
 * into `Output[]`, and fed to `rig.receive`. One endpoint per *source*
 * (GitHub, Stripe, a partner, another B3nd node) keyed by a path
 * segment, each with its own verify + decode hooks (see `./source.ts`).
 *
 *   POST /api/v1/webhooks/in/:source
 *     unknown source        → 404
 *     verify throws          → 401 (Unauthorized) — or whatever status
 *                              the thrown HttpError carries
 *     decode throws          → 400 (BadRequest)
 *     rig.receive throws     → 500
 *     otherwise              → 200 with `ReceiveResult[]` JSON (or a
 *                              host-supplied `ack`)
 *
 * The route is fixed; the per-source hooks are the only knobs — same
 * "locked surface, host owns the decoding decision" shape as the rest of
 * the move layer. Runtime binding (Deno.serve / Workers / Hono), CORS,
 * and IP allow-listing are the host's job; wrap the returned handler.
 *
 * @example
 * ```ts
 * import { webhooksInApi } from "@bandeira-tech/b3nd-move/webhooks/in/service";
 * import { verify, decode }
 *   from "@bandeira-tech/b3nd-move/webhooks/in/source";
 *
 * Deno.serve({ port: 3000 }, webhooksInApi(rig, {
 *   sources: {
 *     github: {
 *       verify: verify.hmacSha256({ secret: GH_SECRET, header: "X-Hub-Signature-256" }),
 *       decode: decode.json((e) => [[
 *         `mutable://gh/${(e as { repository: { id: number } }).repository.id}`,
 *         new TextEncoder().encode(JSON.stringify(e)),
 *       ]]),
 *     },
 *   },
 * }));
 * ```
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import type { ReceiveResult } from "@bandeira-tech/b3nd-core/types";
import { receiveAction } from "../../actions/standard.ts";
import { NotFound } from "../../router/errors.ts";
import { dispatchHttp, httpRequest, route } from "../../http/router.ts";
import { json } from "../../http/wire.ts";
import type { WebhookSource } from "./source.ts";

export type { WebhookSource };

export interface WebhooksInApiOptions {
  /** Endpoints keyed by the `:source` path segment. */
  sources: Record<string, WebhookSource>;
  /**
   * Shape the success response. Default: `200` with the rig's
   * `ReceiveResult[]` as JSON. Override to send a sender-specific ack
   * (e.g. an empty `200` GitHub expects).
   */
  ack?: (results: ReceiveResult[]) => Response;
}

/**
 * Build the inbound route table. Exported alongside `webhooksInApi` so
 * the combined `webhooksApi` can merge it with the outbound routes into
 * a single dispatch.
 */
export function webhooksInRoutes(
  options: WebhooksInApiOptions,
): Array<ReturnType<typeof route>> {
  const { sources } = options;
  const ack = options.ack ?? ((results: ReceiveResult[]) => json(results, 200));
  return [
    route({
      on: httpRequest("POST", "/api/v1/webhooks/in/:source"),
      decode: async ({ req, params }) => {
        const source = sources[params.source];
        if (!source) throw new NotFound(`Unknown source "${params.source}"`);
        const body = new Uint8Array(await req.arrayBuffer());
        const ctx = { req, body, headers: req.headers, params };
        if (source.verify) await source.verify(ctx);
        const outputs = await source.decode(ctx);
        return [outputs] as const;
      },
      action: receiveAction,
      encode: (results) => ack(results),
    }),
  ];
}

/**
 * Create an inbound-webhook HTTP handler backed by a Rig. Returns a
 * standard `(Request) => Promise<Response>`.
 */
export function webhooksInApi(
  rig: Rig,
  options: WebhooksInApiOptions,
): (req: Request) => Promise<Response> {
  const routes = webhooksInRoutes(options);
  return (req) => dispatchHttp(rig, routes, req);
}
