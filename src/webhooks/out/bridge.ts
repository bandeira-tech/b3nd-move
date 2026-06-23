/**
 * @module
 * Webhooks **out** — bridging rig results to a {@link WebhookSender}.
 *
 * Two shapes of outbound cooperation:
 *
 *   readToWebhook     run `rig.read(urls)` once, deliver the outputs as a
 *                     single `"read"` event. The push counterpart of a
 *                     one-shot read.
 *   observeToWebhook  drain `rig.observe(urls, signal)`, delivering each
 *                     frame as it fires as an `"observe"` event, until the
 *                     stream ends or `signal` aborts. The push counterpart
 *                     of the NDJSON observe stream — the consumer holds no
 *                     connection open; results arrive at their endpoint.
 *
 * Payloads are plain JSON (`Output[]` for reads, the fired url batch for
 * observe), so the receiver decodes with `await req.json()` — no
 * bytes-list framing. A binary `Uint8Array` read payload would not
 * survive `JSON.stringify`; hosts that read raw bytes should map them to
 * a JSON-safe shape in their rig/client before bridging.
 *
 * Delivery is best-effort: the sender reports failures rather than
 * throwing. `onDelivery` lets the caller observe every outcome (logging,
 * metrics, disabling a dead endpoint); failures otherwise pass silently
 * so one bad frame doesn't tear down the observe loop.
 */

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import type { Output } from "@bandeira-tech/b3nd-core/types";
import type { DeliveryResult, WebhookSender } from "./sender.ts";

export interface BridgeOptions {
  /** Called with the outcome of every delivery attempt sequence. */
  onDelivery?: (result: DeliveryResult) => void;
}

/**
 * Read `urls` once and deliver the resulting `Output[]` as one `"read"`
 * event. Returns the delivery outcome.
 */
export async function readToWebhook(
  rig: Rig,
  urls: string[],
  sender: WebhookSender,
  options: BridgeOptions = {},
): Promise<DeliveryResult> {
  const outputs: Output[] = await rig.read(urls);
  const result = await sender({ type: "read", data: { urls, outputs } });
  options.onDelivery?.(result);
  return result;
}

export interface ObserveBridgeOptions extends BridgeOptions {
  /**
   * Resolve each fired url through `rig.read` and include the outputs in
   * the delivery (`{ urls, outputs }`). Default `false` — deliver only
   * the fired url batch (`{ urls }`), letting the consumer pull detail
   * itself.
   */
  hydrate?: boolean;
}

/**
 * Observe `urls` and deliver each frame as an `"observe"` event until the
 * stream ends or `signal` aborts. Resolves when observation finishes.
 *
 * With `hydrate`, each frame's urls are read and the outputs ride along;
 * without it, only the fired-url batch is sent. A `seq` counter is
 * attached as the event `id` so receivers can order / dedupe deliveries.
 */
export async function observeToWebhook(
  rig: Rig,
  urls: string[],
  sender: WebhookSender,
  signal: AbortSignal,
  options: ObserveBridgeOptions = {},
): Promise<void> {
  let seq = 0;
  for await (const frame of rig.observe(urls, signal)) {
    if (signal.aborted) break;
    const fired = [...frame];
    const data = options.hydrate
      ? { urls: fired, outputs: await rig.read(fired) }
      : { urls: fired };
    const result = await sender({ type: "observe", id: String(seq++), data });
    options.onDelivery?.(result);
  }
}
