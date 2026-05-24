/**
 * @module
 * `{ type: "observe-cancel", id, payload: {} }` — fire-and-forget
 * control frame that aborts the matching observe subscription.
 *
 * No rig call. No reply on the wire. The factory closes over the
 * per-socket `observes` map populated by `observe.ts`; the route's
 * `action` looks the id up and aborts. The active observe handler
 * sees the abort, exits its loop, and emits the terminator frame on
 * its own `finally` — there's nothing for this route to encode.
 *
 * This is the canonical custom-action example: the work happens
 * entirely in a closure over transport state, not via the rig. The
 * action signature stays uniform — `(rig, args, signal)` — but the
 * route ignores `rig` and `signal` and uses the captured map instead.
 */

import { route, wsData } from "./router.ts";

export function observeCancelRoute(observes: Map<string, AbortController>) {
  return route({
    on: wsData("observe-cancel"),
    decode: ({ id }) => [id] as const,
    action: (_rig, [id]) => {
      observes.get(id)?.abort();
    },
    encode: () => undefined,
  });
}
