/**
 * @module
 * SSE (Server-Sent Events) stream client.
 *
 * Uses `fetch()` with a streaming response body — works in Deno and
 * modern browsers without the `EventSource` API. Parses the SSE wire
 * protocol (`data:`, `id:`, `event:` fields) and yields typed events.
 *
 * Supports auto-reconnect with `Last-Event-ID` and exponential backoff.
 */

/** A single parsed SSE event. */
export interface SseEvent {
  /** Single uri (back-compat shape — server may still emit this). */
  uri?: string;
  /** Bundled uris (INV package shape). */
  uris?: string[];
  data?: unknown;
  ts?: number;
  id?: string;
}

/** Options for opening an SSE stream. */
export interface SseStreamOptions {
  /** Resume from this event ID (sent as Last-Event-ID header). */
  lastEventId?: string;
  /** Abort signal to close the stream. */
  signal?: AbortSignal;
  /** Maximum reconnect delay in ms. Default: 30000. */
  maxReconnectMs?: number;
  /** Initial reconnect delay in ms. Default: 1000. */
  initialReconnectMs?: number;
}

/**
 * Open an SSE stream and yield parsed events.
 *
 * Auto-reconnects on network errors with exponential backoff.
 * Stops when the signal is aborted.
 *
 * @example
 * ```ts
 * const abort = new AbortController();
 * for await (const event of openSseStream("https://node/api/v1/observe/mutable/data/market/X", {
 *   signal: abort.signal,
 * })) {
 *   console.log(event.uri, event.data);
 * }
 * ```
 */
export async function* openSseStream(
  url: string,
  options?: SseStreamOptions,
): AsyncGenerator<SseEvent, void, unknown> {
  const signal = options?.signal;
  const maxDelay = options?.maxReconnectMs ?? 30_000;
  let delay = options?.initialReconnectMs ?? 1_000;
  let lastId = options?.lastEventId ?? "";

  while (!signal?.aborted) {
    try {
      const headers: Record<string, string> = {
        Accept: "text/event-stream",
      };
      if (lastId) {
        headers["Last-Event-ID"] = lastId;
      }

      const response = await fetch(url, { headers, signal });

      if (!response.ok) {
        throw new Error(`SSE connect failed: ${response.status}`);
      }

      if (!response.body) {
        throw new Error("SSE response has no body");
      }

      // Reset backoff on successful connection
      delay = options?.initialReconnectMs ?? 1_000;

      // Parse the SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Cancel reader when signal fires (fetch signal only affects the initial request)
      const onAbort = () => {
        reader.cancel().catch(() => {});
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      // Current event being built
      let eventData = "";
      let eventId = "";

      try {
        while (!signal?.aborted) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete lines
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line === "") {
              // Empty line = end of event
              if (eventData) {
                try {
                  const parsed = JSON.parse(eventData);
                  if (parsed.uri) {
                    lastId = eventId || String(parsed.ts ?? "");
                    yield {
                      uri: parsed.uri,
                      data: parsed.data,
                      ts: parsed.ts ?? Date.now(),
                      id: lastId,
                    };
                  }
                } catch {
                  // Skip malformed events
                }
                eventData = "";
                eventId = "";
              }
            } else if (line.startsWith("data: ")) {
              eventData += line.slice(6);
            } else if (line.startsWith("data:")) {
              eventData += line.slice(5);
            } else if (line.startsWith("id: ")) {
              eventId = line.slice(4);
            } else if (line.startsWith("id:")) {
              eventId = line.slice(3);
            }
            // Ignore event:, retry:, and comments (lines starting with :)
          }
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        try {
          reader.cancel();
        } catch {
          // Ignore cancel errors
        }
      }
    } catch (err) {
      if (signal?.aborted) return;
      // deno-lint-ignore no-explicit-any
      if ((err as any)?.name === "AbortError") return;

      console.warn(`[sse] connection error, reconnecting in ${delay}ms:`, err);

      // Wait with backoff
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });

      // Exponential backoff, capped
      delay = Math.min(delay * 2, maxDelay);
    }
  }
}
