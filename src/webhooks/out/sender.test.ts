/// <reference lib="deno.ns" />
/**
 * createWebhookSender: body shape, signing, retry/backoff, terminal
 * failures. `fetch` and `sleep` are injected so nothing hits the network
 * or the clock.
 */

import { assertEquals } from "@std/assert";
import { hmacSha256Hex } from "../hmac.ts";
import { createWebhookSender } from "./sender.ts";

interface Call {
  url: string;
  init: RequestInit;
}

/** Build a fake fetch that returns each queued status in turn. */
function fakeFetch(statuses: number[]) {
  const calls: Call[] = [];
  let i = 0;
  const fn = (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const status = statuses[Math.min(i, statuses.length - 1)];
    i++;
    return Promise.resolve(new Response(null, { status }));
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

const noSleep = () => Promise.resolve();

Deno.test("delivers on first 2xx; body carries type/data/ts", async () => {
  const { fn, calls } = fakeFetch([200]);
  const send = createWebhookSender({
    url: "http://sink",
    fetch: fn,
    sleep: noSleep,
  });
  const res = await send({ type: "observe", data: { urls: ["a"] } });
  assertEquals(res, { ok: true, status: 200, attempts: 1 });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "http://sink");
  const body = JSON.parse(calls[0].init.body as string);
  assertEquals(body.type, "observe");
  assertEquals(body.data, { urls: ["a"] });
  assertEquals(typeof body.ts, "number");
});

Deno.test("includes id when provided", async () => {
  const { fn, calls } = fakeFetch([200]);
  const send = createWebhookSender({
    url: "http://sink",
    fetch: fn,
    sleep: noSleep,
  });
  await send({ type: "read", id: "9", data: {} });
  assertEquals(JSON.parse(calls[0].init.body as string).id, "9");
});

Deno.test("signs the body with HMAC when a secret is set", async () => {
  const { fn, calls } = fakeFetch([200]);
  const send = createWebhookSender({
    url: "http://sink",
    secret: "shh",
    fetch: fn,
    sleep: noSleep,
  });
  await send({ type: "observe", data: { n: 1 } });
  const sent = calls[0].init.body as string;
  const header = new Headers(calls[0].init.headers).get("X-B3nd-Signature");
  const expected = `sha256=${await hmacSha256Hex(
    "shh",
    new TextEncoder().encode(sent),
  )}`;
  assertEquals(header, expected);
});

Deno.test("no signature header when no secret", async () => {
  const { fn, calls } = fakeFetch([200]);
  const send = createWebhookSender({
    url: "http://sink",
    fetch: fn,
    sleep: noSleep,
  });
  await send({ type: "observe", data: {} });
  assertEquals(
    new Headers(calls[0].init.headers).get("X-B3nd-Signature"),
    null,
  );
});

Deno.test("retries on 5xx then succeeds; counts attempts", async () => {
  const { fn, calls } = fakeFetch([503, 503, 200]);
  const send = createWebhookSender({
    url: "http://sink",
    fetch: fn,
    sleep: noSleep,
  });
  const res = await send({ type: "observe", data: {} });
  assertEquals(res.ok, true);
  assertEquals(res.attempts, 3);
  assertEquals(calls.length, 3);
});

Deno.test("retries on 429", async () => {
  const { fn } = fakeFetch([429, 200]);
  const send = createWebhookSender({
    url: "http://sink",
    fetch: fn,
    sleep: noSleep,
  });
  const res = await send({ type: "observe", data: {} });
  assertEquals(res.ok, true);
  assertEquals(res.attempts, 2);
});

Deno.test("gives up after retries exhausted", async () => {
  const { fn, calls } = fakeFetch([500]);
  const send = createWebhookSender({
    url: "http://sink",
    fetch: fn,
    sleep: noSleep,
    retries: 2,
  });
  const res = await send({ type: "observe", data: {} });
  assertEquals(res.ok, false);
  assertEquals(res.status, 500);
  assertEquals(res.attempts, 3); // 1 + 2 retries
  assertEquals(calls.length, 3);
  assertEquals(res.error, "HTTP 500");
});

Deno.test("does NOT retry on a 4xx (receiver rejected)", async () => {
  const { fn, calls } = fakeFetch([400, 200]);
  const send = createWebhookSender({
    url: "http://sink",
    fetch: fn,
    sleep: noSleep,
  });
  const res = await send({ type: "observe", data: {} });
  assertEquals(res.ok, false);
  assertEquals(res.status, 400);
  assertEquals(res.attempts, 1);
  assertEquals(calls.length, 1);
});

Deno.test("retries on network error then succeeds", async () => {
  let i = 0;
  const fn = ((_url: string | URL | Request, _init?: RequestInit) => {
    i++;
    if (i === 1) return Promise.reject(new Error("ECONNREFUSED"));
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as unknown as typeof fetch;
  const send = createWebhookSender({
    url: "http://sink",
    fetch: fn,
    sleep: noSleep,
  });
  const res = await send({ type: "observe", data: {} });
  assertEquals(res.ok, true);
  assertEquals(res.attempts, 2);
});

Deno.test("network error to exhaustion reports the error", async () => {
  const fn =
    (() => Promise.reject(new Error("boom"))) as unknown as typeof fetch;
  const send = createWebhookSender({
    url: "http://sink",
    fetch: fn,
    sleep: noSleep,
    retries: 1,
  });
  const res = await send({ type: "observe", data: {} });
  assertEquals(res.ok, false);
  assertEquals(res.attempts, 2);
  assertEquals(res.error, "boom");
});

Deno.test("backoff is consulted between attempts with the retry number", async () => {
  const { fn } = fakeFetch([500, 500, 200]);
  const seen: number[] = [];
  const send = createWebhookSender({
    url: "http://sink",
    fetch: fn,
    sleep: (ms) => {
      seen.push(ms);
      return Promise.resolve();
    },
    backoff: (attempt) => attempt * 10,
  });
  await send({ type: "observe", data: {} });
  assertEquals(seen, [10, 20]); // before attempt 2 and attempt 3
});
