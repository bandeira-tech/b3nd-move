/// <reference lib="deno.ns" />
/**
 * http/wire.ts: tiny helpers used by route files.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { BadRequest } from "../router/errors.ts";
import { json, readJson } from "./wire.ts";

// ── json ──

Deno.test("json: serialises data with application/json content-type, default 200", async () => {
  const r = json({ a: 1, b: "two" });
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("Content-Type"), "application/json");
  assertEquals(await r.json(), { a: 1, b: "two" });
});

Deno.test("json: explicit status overrides default", () => {
  assertEquals(json({}, 503).status, 503);
});

Deno.test("json: handles primitives, null, arrays", async () => {
  assertEquals(await json(null).json(), null);
  assertEquals(await json(42).json(), 42);
  assertEquals(await json([1, 2, 3]).json(), [1, 2, 3]);
});

// ── readJson ──

Deno.test("readJson: returns parsed body on valid JSON", async () => {
  const req = new Request("http://x", {
    method: "POST",
    body: JSON.stringify({ x: 1 }),
    headers: { "Content-Type": "application/json" },
  });
  assertEquals(await readJson(req), { x: 1 });
});

Deno.test("readJson: throws BadRequest on invalid JSON", async () => {
  const req = new Request("http://x", {
    method: "POST",
    body: "not-json{",
    headers: { "Content-Type": "application/json" },
  });
  await assertRejects(() => readJson(req), BadRequest, "Invalid JSON body");
});

Deno.test("readJson: throws BadRequest on empty body", async () => {
  const req = new Request("http://x", { method: "POST" });
  await assertRejects(() => readJson(req), BadRequest, "Invalid JSON body");
});
