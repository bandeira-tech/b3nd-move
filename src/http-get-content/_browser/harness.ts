/**
 * Browser entry for the httpGetContentApi conformance run.
 *
 * Issues real `fetch` calls from a headless browser against the
 * GET-content facet booted by `_conformance/server.ts`, asserting the
 * content-type mapping end-to-end. Content transports are not PIN-
 * symmetric, so this is a bespoke suite rather than `runMoveSuite`.
 */

import { serverUrl, setupHarness } from "../../../tests/browser/deno-stub.ts";

const SUITE = "httpGetContentApi (browser)";

function urlFor(uri: string): string {
  return `${serverUrl()}/api/v1/content/${encodeURIComponent(uri)}`;
}

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? "values differ"}: got ${a}, want ${e}`);
  }
}

Deno.test({
  name: `${SUITE} — png returns image/png bytes`,
  fn: async () => {
    const r = await fetch(urlFor("mutable://t/icon.png"));
    assertEquals(r.status, 200);
    assertEquals(r.headers.get("Content-Type"), "image/png");
    const bytes = new Uint8Array(await r.arrayBuffer());
    assertEquals(Array.from(bytes), [0x89, 0x50, 0x4e, 0x47]);
  },
});

Deno.test({
  name: `${SUITE} — txt returns text/plain body`,
  fn: async () => {
    const r = await fetch(urlFor("mutable://t/note.txt"));
    assertEquals(r.status, 200);
    assertEquals(r.headers.get("Content-Type"), "text/plain");
    assertEquals(await r.text(), "hello");
  },
});

Deno.test({
  name: `${SUITE} — unmatched extension falls back to JSON`,
  fn: async () => {
    const uri = "mutable://t/plain";
    const r = await fetch(urlFor(uri));
    assertEquals(r.status, 200);
    assertEquals(r.headers.get("Content-Type"), "application/json");
    const body = await r.json();
    assertEquals(body, { echo: uri, kind: "obj" });
  },
});

Deno.test({
  // CORS hides response headers (incl. `Allow`) that aren't in the
  // safelist or `Access-Control-Expose-Headers`. Status is sufficient
  // end-to-end here — the unit test covers the header value.
  name: `${SUITE} — non-GET → 405`,
  fn: async () => {
    const r = await fetch(urlFor("mutable://t/plain"), { method: "POST" });
    assertEquals(r.status, 405);
    await r.text();
  },
});

Deno.test({
  name: `${SUITE} — path outside prefix → 404`,
  fn: async () => {
    const r = await fetch(`${serverUrl()}/elsewhere/thing`);
    assertEquals(r.status, 404);
    await r.text();
  },
});

setupHarness();
