/// <reference lib="deno.ns" />
/**
 * ndjsonResponse: drain an AsyncIterable as NDJSON over a fetch Response.
 *
 * Behavioural pins:
 *  - one JSON line per frame, default encoding is identity
 *  - frameEncode can shape per-frame wire JSON
 *  - extraHeaders are merged with the defaults
 *  - upstream-iter error becomes a trailing `{ "error": "..." }` line
 *  - if the request is already aborted, the trailing error is suppressed
 *  - consumer cancel fires the abort controller (propagates upstream)
 */

import { assertEquals } from "@std/assert";
import { ndjsonResponse } from "./ndjson.ts";

async function lines(res: Response): Promise<string[]> {
  const text = await res.text();
  return text.split("\n").filter((l) => l.length > 0);
}

async function* iter<T>(items: T[]): AsyncIterable<T> {
  for (const x of items) {
    await Promise.resolve();
    yield x;
  }
}

Deno.test("ndjsonResponse: emits one JSON line per frame, identity by default", async () => {
  const res = ndjsonResponse(iter([{ a: 1 }, { b: 2 }]), new AbortController());
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Content-Type"), "application/x-ndjson");
  assertEquals(res.headers.get("Cache-Control"), "no-cache");
  assertEquals(await lines(res), [`{"a":1}`, `{"b":2}`]);
});

Deno.test("ndjsonResponse: frameEncode shapes per-frame wire JSON", async () => {
  const res = ndjsonResponse(
    iter([["a", "b"], ["c"]]),
    new AbortController(),
    (frame) => ({ uris: frame }),
  );
  assertEquals(await lines(res), [
    `{"uris":["a","b"]}`,
    `{"uris":["c"]}`,
  ]);
});

Deno.test("ndjsonResponse: extraHeaders merged with defaults", () => {
  const res = ndjsonResponse(iter([]), new AbortController(), undefined, {
    "X-Accel-Buffering": "no",
  });
  assertEquals(res.headers.get("X-Accel-Buffering"), "no");
  assertEquals(res.headers.get("Content-Type"), "application/x-ndjson");
});

Deno.test("ndjsonResponse: upstream throw → trailing error line", async () => {
  async function* boom(): AsyncIterable<unknown> {
    yield { ok: true };
    throw new Error("kaboom");
  }
  const res = ndjsonResponse(boom(), new AbortController());
  const out = await lines(res);
  assertEquals(out, [`{"ok":true}`, `{"error":"kaboom"}`]);
});

Deno.test("ndjsonResponse: upstream throw after abort → no trailing error", async () => {
  const ac = new AbortController();
  async function* boom(): AsyncIterable<unknown> {
    yield { ok: true };
    ac.abort();
    throw new Error("after abort");
  }
  const res = ndjsonResponse(boom(), ac);
  const out = await lines(res);
  // Aborted before the throw → no error frame.
  assertEquals(out, [`{"ok":true}`]);
});

Deno.test("ndjsonResponse: abort mid-stream stops iteration", async () => {
  const ac = new AbortController();
  let yielded = 0;
  async function* infinite(): AsyncIterable<number> {
    while (true) {
      await Promise.resolve();
      yield ++yielded;
      if (yielded === 2) ac.abort();
    }
  }
  const res = ndjsonResponse(infinite(), ac);
  const out = await lines(res);
  // Yielded 1 and 2 before the abort fired; after the abort, the
  // `if (abort.signal.aborted) break;` check stops emission.
  assertEquals(out, [`1`, `2`]);
});

Deno.test("ndjsonResponse: consumer cancel fires the supplied abort", async () => {
  const ac = new AbortController();
  let aborted = false;
  ac.signal.addEventListener("abort", () => {
    aborted = true;
  });
  const res = ndjsonResponse(iter([1, 2, 3]), ac);
  // Reading body and immediately cancelling the reader triggers the
  // ReadableStream `cancel` hook, which calls `abort.abort()`.
  const reader = res.body!.getReader();
  await reader.cancel();
  assertEquals(aborted, true);
});
