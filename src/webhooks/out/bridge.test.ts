/// <reference lib="deno.ns" />
/**
 * readToWebhook / observeToWebhook: drive a real Rig (the shared stub)
 * into a capturing sender. No network — the sender records events.
 */

import { assertEquals } from "@std/assert";
import { stubRig } from "../../../tests/rigs/stub.ts";
import type { DeliveryResult, WebhookEvent, WebhookSender } from "./sender.ts";
import { observeToWebhook, readToWebhook } from "./bridge.ts";

/** A sender that records events and returns a canned ok result. */
function capturing(
  result: DeliveryResult = { ok: true, status: 200, attempts: 1 },
) {
  const events: WebhookEvent[] = [];
  const sender: WebhookSender = (e) => {
    events.push(e);
    return Promise.resolve(result);
  };
  return { sender, events };
}

Deno.test("readToWebhook: reads once, delivers one 'read' event", async () => {
  const { sender, events } = capturing();
  const res = await readToWebhook(stubRig(), ["mutable://t/x"], sender);
  assertEquals(res.ok, true);
  assertEquals(events.length, 1);
  assertEquals(events[0].type, "read");
  const data = events[0].data as { urls: string[]; outputs: unknown[] };
  assertEquals(data.urls, ["mutable://t/x"]);
  // stub echoes { echo: url }
  assertEquals(data.outputs, [["mutable://t/x", { echo: "mutable://t/x" }]]);
});

Deno.test("readToWebhook: onDelivery receives the outcome", async () => {
  const { sender } = capturing({
    ok: false,
    status: 500,
    attempts: 4,
    error: "x",
  });
  const seen: DeliveryResult[] = [];
  await readToWebhook(stubRig(), ["mutable://t/x"], sender, {
    onDelivery: (r) => seen.push(r),
  });
  assertEquals(seen.length, 1);
  assertEquals(seen[0].ok, false);
});

// `rig.observe` is a long-lived subscription — the stub emits 3 frames
// then stays open. A bridge consumer ends it by aborting; here we abort
// once the expected frames have arrived.
function abortingSender(
  events: WebhookEvent[],
  after: number,
  ctrl: AbortController,
): WebhookSender {
  return (e) => {
    events.push(e);
    if (events.length >= after) ctrl.abort();
    return Promise.resolve({ ok: true, status: 200, attempts: 1 });
  };
}

Deno.test("observeToWebhook: one 'observe' event per frame, seq ids", async () => {
  const events: WebhookEvent[] = [];
  const ctrl = new AbortController();
  await observeToWebhook(
    stubRig(),
    ["mutable://t/a"],
    abortingSender(events, 3, ctrl),
    ctrl.signal,
  );
  assertEquals(events.length, 3);
  assertEquals(events.map((e) => e.type), ["observe", "observe", "observe"]);
  assertEquals(events.map((e) => e.id), ["0", "1", "2"]);
  assertEquals((events[0].data as { urls: string[] }).urls, [
    "mutable://t/a/0",
  ]);
});

Deno.test("observeToWebhook: hydrate includes read outputs", async () => {
  const events: WebhookEvent[] = [];
  const ctrl = new AbortController();
  await observeToWebhook(
    stubRig(),
    ["mutable://t/a"],
    abortingSender(events, 3, ctrl),
    ctrl.signal,
    { hydrate: true },
  );
  assertEquals(events.length, 3);
  const data = events[0].data as { urls: string[]; outputs: unknown[] };
  assertEquals(data.urls, ["mutable://t/a/0"]);
  assertEquals(data.outputs, [["mutable://t/a/0", {
    echo: "mutable://t/a/0",
  }]]);
});

Deno.test("observeToWebhook: pre-aborted signal delivers nothing", async () => {
  const { sender, events } = capturing();
  const ctrl = new AbortController();
  ctrl.abort();
  await observeToWebhook(stubRig(), ["mutable://t/a"], sender, ctrl.signal);
  assertEquals(events.length, 0);
});

Deno.test("observeToWebhook: abort mid-stream stops further delivery", async () => {
  const { events } = capturing();
  const ctrl = new AbortController();
  // Abort as soon as the first frame is delivered.
  const sender: WebhookSender = (e) => {
    events.push(e);
    ctrl.abort();
    return Promise.resolve({ ok: true, status: 200, attempts: 1 });
  };
  await observeToWebhook(stubRig(), ["mutable://t/a"], sender, ctrl.signal);
  assertEquals(events.length, 1);
});
