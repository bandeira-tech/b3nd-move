/// <reference lib="deno.ns" />
/**
 * webhooksOutApi: subscription lifecycle, one-shot read push, validation.
 * The sender is injected so deliveries are captured, not networked.
 */

import { assertEquals } from "@std/assert";
import { stubRig } from "../../../tests/rigs/stub.ts";
import type { WebhookEvent, WebhookSenderConfig } from "./sender.ts";
import { memoryRegistry, webhooksOutApi } from "./service.ts";

interface Captured {
  config: WebhookSenderConfig;
  events: WebhookEvent[];
}

/** Injectable sender factory that records the config + every event. */
function captureSender() {
  const made: Captured[] = [];
  const createSender = (config: WebhookSenderConfig) => {
    const entry: Captured = { config, events: [] };
    made.push(entry);
    return (event: WebhookEvent) => {
      entry.events.push(event);
      return Promise.resolve({ ok: true, status: 200, attempts: 1 });
    };
  };
  return { made, createSender };
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://test${path}`, init);
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const SUBS = "/api/v1/webhooks/out/subscriptions";

Deno.test("subscribe → 201 with subscription; observe pushed to sender", async () => {
  const { made, createSender } = captureSender();
  const registry = memoryRegistry();
  const api = webhooksOutApi(stubRig(), { registry, createSender });

  const r = await api(req(SUBS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "http://sink", urls: ["mutable://t/a"] }),
  }));
  assertEquals(r.status, 201);
  const sub = await r.json();
  assertEquals(sub.url, "http://sink");
  assertEquals(sub.urls, ["mutable://t/a"]);
  assertEquals(typeof sub.id, "string");

  // observe is long-lived: the stub emits 3 frames then stays open, so
  // the subscription remains registered until torn down.
  await waitFor(() => (made[0]?.events.length ?? 0) >= 3);
  assertEquals(made[0].events[0].type, "observe");
  assertEquals(registry.list().length, 1);

  registry.closeAll();
});

Deno.test("subscribe passes secret + hydrate through", async () => {
  const { made, createSender } = captureSender();
  const registry = memoryRegistry();
  const api = webhooksOutApi(stubRig(), { registry, createSender });
  await api(req(SUBS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "http://sink",
      urls: ["mutable://t/a"],
      secret: "shh",
      hydrate: true,
    }),
  }));
  await waitFor(() => (made[0]?.events.length ?? 0) >= 1);
  assertEquals(made[0].config.secret, "shh");
  // hydrate → outputs ride along
  const data = made[0].events[0].data as { outputs?: unknown[] };
  assertEquals(Array.isArray(data.outputs), true);
  registry.closeAll();
});

Deno.test("finite observe stream self-removes from the registry", async () => {
  const { createSender } = captureSender();
  const registry = memoryRegistry();
  const rig = stubRig();
  // A finite observe that ends naturally after 2 frames.
  (rig as unknown as { observe: unknown }).observe = async function* (
    _urls: string[],
    _signal: AbortSignal,
  ) {
    yield ["mutable://t/a/0"];
    yield ["mutable://t/a/1"];
  };
  const api = webhooksOutApi(rig, { registry, createSender });
  await api(req(SUBS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "http://sink", urls: ["mutable://t/a"] }),
  }));
  // The detached loop drains both frames, then `.finally` drops the entry.
  await waitFor(() => registry.list().length === 0);
  registry.closeAll();
});

Deno.test("GET lists active subscriptions; DELETE removes (204)", async () => {
  // A rig whose observe never ends, so the subscription stays active.
  const { createSender } = captureSender();
  const registry = memoryRegistry();
  const rig = stubRig();
  // Patch observe to a never-ending stream for this test.
  // deno-lint-ignore require-yield
  (rig as unknown as { observe: unknown }).observe = async function* (
    _urls: string[],
    signal: AbortSignal,
  ) {
    while (!signal.aborted) await new Promise((r) => setTimeout(r, 10));
  };
  const api = webhooksOutApi(rig, { registry, createSender });

  const created = await (await api(req(SUBS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "http://sink", urls: ["mutable://t/a"] }),
  }))).json();

  const listed = await (await api(req(SUBS, { method: "GET" }))).json();
  assertEquals(listed.length, 1);
  assertEquals(listed[0].id, created.id);

  const del = await api(req(`${SUBS}/${created.id}`, { method: "DELETE" }));
  assertEquals(del.status, 204);

  const after = await (await api(req(SUBS, { method: "GET" }))).json();
  assertEquals(after.length, 0);
  registry.closeAll();
});

Deno.test("DELETE unknown id → 404", async () => {
  const { createSender } = captureSender();
  const api = webhooksOutApi(stubRig(), { createSender });
  const r = await api(req(`${SUBS}/does-not-exist`, { method: "DELETE" }));
  assertEquals(r.status, 404);
});

Deno.test("one-shot read push → 200 with delivery outcome", async () => {
  const { made, createSender } = captureSender();
  const api = webhooksOutApi(stubRig(), { createSender });
  const r = await api(req("/api/v1/webhooks/out/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "http://sink", urls: ["mutable://t/x"] }),
  }));
  assertEquals(r.status, 200);
  const out = await r.json();
  assertEquals(out.delivered.ok, true);
  assertEquals(made[0].events[0].type, "read");
});

Deno.test("invalid body → 400", async () => {
  const { createSender } = captureSender();
  const api = webhooksOutApi(stubRig(), { createSender });
  for (
    const bad of [
      `{}`,
      `{"url":"http://x"}`,
      `{"url":"http://x","urls":[]}`,
      `{"url":"http://x","urls":[1,2]}`,
      `{"urls":["a"]}`,
    ]
  ) {
    const r = await api(req(SUBS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bad,
    }));
    assertEquals(r.status, 400, `expected 400 for ${bad}`);
  }
});

Deno.test("non-POST on subscriptions collection → 405", async () => {
  const { createSender } = captureSender();
  const api = webhooksOutApi(stubRig(), { createSender });
  const r = await api(req(SUBS, { method: "PUT" }));
  assertEquals(r.status, 405);
});

Deno.test("closeAll aborts active subscriptions", async () => {
  const { createSender } = captureSender();
  const registry = memoryRegistry();
  const rig = stubRig();
  let aborted = false;
  // deno-lint-ignore require-yield
  (rig as unknown as { observe: unknown }).observe = async function* (
    _urls: string[],
    signal: AbortSignal,
  ) {
    signal.addEventListener("abort", () => (aborted = true));
    while (!signal.aborted) await new Promise((r) => setTimeout(r, 10));
  };
  const api = webhooksOutApi(rig, { registry, createSender });
  await api(req(SUBS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "http://sink", urls: ["mutable://t/a"] }),
  }));
  assertEquals(registry.list().length, 1);
  registry.closeAll();
  await waitFor(() => aborted);
  assertEquals(registry.list().length, 0);
});
