/// <reference lib="deno.ns" />
/**
 * validateOutputs / validateUrls: shape validators used by the
 * JSON-shaped transports. They return tagged results, never throw.
 */

import { assertEquals } from "@std/assert";
import { validateOutputs, validateUrls } from "./validate.ts";

// ── validateOutputs ──

Deno.test("validateOutputs: valid [[uri, payload], ...] → { ok: true, value }", () => {
  const v = validateOutputs([
    ["mutable://a", { x: 1 }],
    ["mutable://b", null],
  ]);
  assertEquals(v.ok, true);
  assertEquals(v.ok && v.value.length, 2);
});

Deno.test("validateOutputs: empty array → error", () => {
  const v = validateOutputs([]);
  assertEquals(v, { ok: false, error: "Expected [[uri, payload], ...]" });
});

Deno.test("validateOutputs: non-array → error", () => {
  for (const bad of [null, undefined, {}, "string", 42, true]) {
    const v = validateOutputs(bad);
    assertEquals(v.ok, false);
    assertEquals(v.ok || v.error, "Expected [[uri, payload], ...]");
  }
});

Deno.test("validateOutputs: inner element not a 2-tuple → error", () => {
  const v = validateOutputs([["mutable://a"]]);
  assertEquals(v, { ok: false, error: "Expected [[uri, payload], ...]" });
});

Deno.test("validateOutputs: non-string uri → 'URI is required'", () => {
  const v = validateOutputs([[null, { p: 1 }]]);
  assertEquals(v, { ok: false, error: "URI is required" });
});

Deno.test("validateOutputs: empty-string uri → 'URI is required'", () => {
  const v = validateOutputs([["", { p: 1 }]]);
  assertEquals(v, { ok: false, error: "URI is required" });
});

// ── validateUrls ──

Deno.test("validateUrls: valid string[] → { ok: true, value }", () => {
  const v = validateUrls(["mutable://a", "mutable://b"]);
  assertEquals(v.ok, true);
  assertEquals(v.ok && v.value, ["mutable://a", "mutable://b"]);
});

Deno.test("validateUrls: empty array → error", () => {
  assertEquals(validateUrls([]), { ok: false, error: "Expected string[]" });
});

Deno.test("validateUrls: non-array → error", () => {
  for (const bad of [null, undefined, {}, "string", 42]) {
    assertEquals(validateUrls(bad), { ok: false, error: "Expected string[]" });
  }
});

Deno.test("validateUrls: any non-string element → error", () => {
  assertEquals(
    validateUrls(["ok", 42, "ok2"]),
    { ok: false, error: "Expected string[]" },
  );
});
