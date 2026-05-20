/**
 * @module
 * `GET /api/v1/status` — `rig.status()` with optional metadata merged in.
 *
 * Status is unusual because the response shape carries host-defined
 * metadata (`statusMeta`) the rig doesn't know about. The route is a
 * factory so the caller can pass that metadata at instantiation.
 */

import { route } from "../router/http.ts";
import type { Route } from "../router/route.ts";
import { json } from "./wire.ts";

export interface StatusRouteOptions {
  /** Extra metadata merged into status responses. */
  statusMeta?: Record<string, unknown>;
}

export function statusRoute(options?: StatusRouteOptions): Route {
  const statusMeta = options?.statusMeta;
  return route({
    on: { method: "GET", path: "/api/v1/status" },
    action: "status",
    decode: () => [],
    encode: (res) => {
      const body = statusMeta ? { ...res, ...statusMeta } : res;
      return json(body, res.status === "healthy" ? 200 : 503);
    },
  });
}
