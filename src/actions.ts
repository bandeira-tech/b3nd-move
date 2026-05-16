/**
 * @module
 * Transport-agnostic action helpers.
 *
 * Every transport (`http`, `grpc/http`, `ws`) routes a wire request to one
 * of four rig actions: `status`, `receive`, `read`, `observe`. The bits
 * that don't depend on the wire — validating the canonical bare-arg shape
 * and draining a streaming observe into NDJSON — live here so each
 * service can stay focused on encode/decode.
 *
 * gRPC's `service.ts` decodes proto → canonical args before calling into
 * the rig, so it doesn't use the bare-arg validators but shares
 * {@link ndjsonResponse} for its observe stream.
 */

import type { Output } from "@bandeira-tech/b3nd-core/types";

/** Action names, also used verbatim as the WebSocket envelope `type`. */
export type ActionName = "status" | "receive" | "read" | "observe";

/** Result of validating a wire payload against an action's canonical shape. */
export type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Validate a `receive` body of the canonical bare-arg shape: `Output[]`,
 * i.e. a non-empty array of `[uri, payload]` tuples with string `uri`.
 */
export function validateOutputs(body: unknown): Validation<Output[]> {
  if (
    !Array.isArray(body) || body.length === 0 ||
    !body.every((m) => Array.isArray(m) && m.length === 2)
  ) {
    return { ok: false, error: "Expected [[uri, payload], ...]" };
  }
  for (const [uri] of body as [unknown, unknown][]) {
    if (!uri || typeof uri !== "string") {
      return { ok: false, error: "URI is required" };
    }
  }
  return { ok: true, value: body as Output[] };
}

/** Validate a non-empty `string[]` — shared by `read` and `observe`. */
export function validateUrls(body: unknown): Validation<string[]> {
  if (
    !Array.isArray(body) || body.length === 0 ||
    !body.every((u) => typeof u === "string")
  ) {
    return { ok: false, error: "Expected string[]" };
  }
  return { ok: true, value: body as string[] };
}

/**
 * Stream an `AsyncIterable` as NDJSON over a fetch `Response`.
 *
 * Wires `reqSignal` to an internal abort so the caller closing the
 * connection tears down the iterator; per-frame `encode` lets the caller
 * decide what JSON shape lands on the wire (raw frame, proto-mapped, …).
 * Errors thrown mid-stream are surfaced as a final `{ "error": "…" }`
 * frame unless the request was aborted.
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
