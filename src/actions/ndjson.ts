/**
 * @module
 * Drain an `AsyncIterable` over a fetch `Response` as NDJSON.
 *
 * Shared by HTTP and gRPC-over-HTTP for the `observe` action — the rig
 * yields frames, the transport ships one JSON line per frame, the
 * client parses line-by-line. Per-frame `frameEncode` lets the caller
 * decide what JSON shape lands on the wire (raw frame, proto-mapped,
 * …). Errors mid-stream are surfaced as a final `{ "error": "…" }`
 * frame unless the request was aborted first.
 */

/**
 * Stream an `AsyncIterable` as NDJSON over a fetch `Response`.
 *
 * The caller owns the `AbortController` and pre-wires it to whatever
 * lifecycle should tear down the stream (request abort, …). When the
 * response stream's consumer cancels, `ndjsonResponse` aborts the
 * controller, which propagates to the upstream iterable so the rig
 * observer terminates.
 */
export function ndjsonResponse<T>(
  iter: AsyncIterable<T>,
  abort: AbortController,
  frameEncode: (frame: T) => unknown = (f) => f,
  extraHeaders?: Record<string, string>,
): Response {
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const frame of iter) {
          if (abort.signal.aborted) break;
          controller.enqueue(
            enc.encode(JSON.stringify(frameEncode(frame)) + "\n"),
          );
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          const msg = e instanceof Error ? e.message : String(e);
          controller.enqueue(
            enc.encode(JSON.stringify({ error: msg }) + "\n"),
          );
        }
      } finally {
        controller.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...extraHeaders,
    },
  });
}
