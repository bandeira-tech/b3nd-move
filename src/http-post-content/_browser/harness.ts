/**
 * Browser entry for the httpPostContentApi conformance run.
 *
 * Issues real cross-origin `fetch` POSTs from a headless browser against
 * the POST-content facet booted by `_conformance/server.ts`. After each
 * POST, the browser pokes `GET /__seen` to verify the rig received the
 * expected payload shape end-to-end. Bespoke suite (content transports
 * are not PIN-symmetric).
 */

import { serverUrl, setupHarness } from "../../../tests/browser/deno-stub.ts";
import { assertEquals } from "@std/assert";

const SUITE = "httpPostContentApi (browser)";

function postUrl(uri: string): string {
  return `${serverUrl()}/api/v1/content/${encodeURIComponent(uri)}`;
}

async function seen(): Promise<unknown[]> {
  const r = await fetch(`${serverUrl()}/__seen`);
  return await r.json();
}

Deno.test({
  name: `${SUITE} — json body forwarded as object payload`,
  fn: async () => {
    const uri = "mutable://t/json/a";
    const r = await fetch(postUrl(uri), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "thing" }),
    });
    assertEquals(r.status, 200);
    assertEquals((await r.json()).accepted, true);
    const all = await seen();
    const last = all[all.length - 1] as [string, unknown];
    assertEquals(last, [uri, { name: "thing" }]);
  },
});

Deno.test({
  name: `${SUITE} — image/* body wrapped via intoField`,
  fn: async () => {
    const uri = "mutable://t/img/a";
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const r = await fetch(postUrl(uri), {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: bytes,
    });
    assertEquals(r.status, 200);
    const all = await seen();
    const last = all[all.length - 1] as [string, Record<string, unknown>];
    assertEquals(last[0], uri);
    assertEquals(last[1].bytes, Array.from(bytes));
    assertEquals(last[1].contentType, "image/png");
  },
});

Deno.test({
  name: `${SUITE} — text/plain body decoded as string`,
  fn: async () => {
    const uri = "mutable://t/text/a";
    const r = await fetch(postUrl(uri), {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hello there",
    });
    assertEquals(r.status, 200);
    const all = await seen();
    const last = all[all.length - 1] as [string, unknown];
    assertEquals(last, [uri, "hello there"]);
  },
});

Deno.test({
  name: `${SUITE} — unknown content-type falls through to raw bytes`,
  fn: async () => {
    const uri = "mutable://t/oct/a";
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const r = await fetch(postUrl(uri), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    assertEquals(r.status, 200);
    const all = await seen();
    const last = all[all.length - 1] as [string, unknown];
    assertEquals(last, [uri, Array.from(bytes)]);
  },
});

Deno.test({
  name: `${SUITE} — invalid JSON body → 400`,
  fn: async () => {
    const r = await fetch(postUrl("mutable://t/json/b"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    assertEquals(r.status, 400);
    await r.text();
  },
});

Deno.test({
  name: `${SUITE} — non-POST → 405`,
  fn: async () => {
    const r = await fetch(postUrl("mutable://t/json/c"), { method: "GET" });
    assertEquals(r.status, 405);
    await r.text();
  },
});

Deno.test({
  name: `${SUITE} — program rejection surfaces in ReceiveResult`,
  fn: async () => {
    const uri = "mutable://t/__reject__/x";
    const r = await fetch(postUrl(uri), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assertEquals(r.status, 200);
    const result = await r.json();
    assertEquals(result.accepted, false);
  },
});

setupHarness();
