/**
 * @module
 * `{ type: "observe", payload: { urls: string[] } }` → streaming
 * envelopes with `data: string[]` per fired batch, plus a terminator
 * frame with `data: null` on stream end (natural completion, abort, or
 * an `observe-cancel` from the client).
 *
 * `encode` is an async generator that drains the rig's frame iterable
 * and yields one outbound envelope per frame. The `finally` guarantees
 * a terminator regardless of how the iteration ends — the WS client
 * uses that terminator to dispose its subscription.
 *
 * The dispatcher detects the AsyncIterable return and pumps each
 * yielded envelope onto the socket.
 */

import { validateUrls } from "../actions/validate.ts";
import { BadRequest } from "../router/errors.ts";
import { route } from "./router.ts";
import type { WebSocketResponse } from "./client.ts";

export const observeRoute = route({
  on: { type: "observe" },
  action: "observe",
  decode: ({ payload }) => {
    const urls = (payload as { urls?: unknown } | null)?.urls;
    const v = validateUrls(urls);
    if (!v.ok) throw new BadRequest(v.error);
    return [v.value];
  },
  encode: (frames, ctx) => streamFrames(frames, ctx.id, ctx.abort),
});

async function* streamFrames(
  frames: AsyncIterable<readonly string[]>,
  id: string,
  abort: AbortController,
): AsyncIterable<WebSocketResponse> {
  try {
    for await (const data of frames) {
      if (abort.signal.aborted) break;
      yield { id, success: true, data };
    }
  } finally {
    yield { id, success: true, data: null };
  }
}
