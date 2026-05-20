/**
 * @module
 * Bare-arg validators used by JSON-shaped transports.
 *
 * The HTTP and WS services accept canonical bare-arg bodies — exactly
 * the argument the corresponding rig method takes — so they share
 * these validators. gRPC decodes proto into the same shape before
 * calling into the rig and doesn't use them.
 *
 * Validators return a tagged result rather than throwing so callers
 * can render a 400 / error envelope in their own wire-specific way.
 */

import type { Output } from "@bandeira-tech/b3nd-core/types";

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
