/**
 * @module
 * `{ type: "observe", payload: { urls: string[] } }` → streaming
 * envelopes with `data: string[]` per fired batch, plus a terminator
 * frame with `data: null` on stream end (natural completion, abort, or
 * an `observe-cancel` from the client).
 *
 * The route is a factory closing over the per-socket `observes` map.
 * `decode` registers `ctx.abort` under the frame's `id` so the
 * companion `observe-cancel` route can find and fire it; `encode`'s
 * async generator cleans the entry on its `finally`, regardless of how
 * iteration ends.
 *
 * The dispatcher detects the AsyncIterable return and pumps each
 * yielded envelope onto the socket.
 */

import { observeAction } from "../actions/standard.ts";
import { validateUrls } from "../actions/validate.ts";
import { BadRequest } from "../router/errors.ts";
import { route, wsData } from "./router.ts";
import type { WebSocketResponse } from "./client.ts";

export function observeRoute(observes: Map<string, AbortController>) {
  return route({
    on: wsData("observe"),
    decode: ({ id, payload, abort }) => {
      const urls = (payload as { urls?: unknown } | null)?.urls;
      const v = validateUrls(urls);
      if (!v.ok) throw new BadRequest(v.error);
      // Register before yielding any frames so a fast follow-up
      // `observe-cancel` always lands on a live entry.
      observes.set(id, abort);
      return [v.value] as const;
    },
    action: observeAction,
    encode: (frames, ctx) => streamFrames(frames, ctx.id, ctx.abort, observes),
  });
}

async function* streamFrames(
  frames: AsyncIterable<readonly string[]>,
  id: string,
  abort: AbortController,
  observes: Map<string, AbortController>,
): AsyncIterable<WebSocketResponse> {
  try {
    for await (const data of frames) {
      if (abort.signal.aborted) break;
      yield { id, success: true, data };
    }
  } finally {
    observes.delete(id);
    yield { id, success: true, data: null };
  }
}
