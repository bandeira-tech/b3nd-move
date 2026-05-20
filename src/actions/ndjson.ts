/**
 * @module
 * Drain an `AsyncIterable` over a fetch `Response` as NDJSON.
 *
 * Shared by HTTP and gRPC-over-HTTP for the `observe` action — the rig
 * yields frames, the transport ships one JSON line per frame, the
 * client parses line-by-line. Per-frame `encode` lets the caller
 * decide what JSON shape lands on the wire (raw frame, proto-mapped,
 * …). Errors mid-stream are surfaced as a final `{ "error": "…" }`
 * frame unless the request was aborted first.
 */

/**
 * Stream an `AsyncIterable` as NDJSON over a fetch `Response`.
 *
 * Wires `reqSignal` to an internal abort so the caller closing the
 * connection tears down the iterator.
 */
export function ndjsonResponse<T>(
  iter: (signal: AbortSignal) => AsyncIterable<T>,
  encode: (frame: T) => unknown,
  reqSignal: AbortSignal,
  extraHeaders?: Record<string, string>,
): Response {
  const abort = new AbortController();
  reqSignal.addEventListener("abort", () => abort.abort());
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const frame of iter(abort.signal)) {
          if (abort.signal.aborted) break;
          controller.enqueue(enc.encode(JSON.stringify(encode(frame)) + "\n"));
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
