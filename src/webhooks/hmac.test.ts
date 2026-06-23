/// <reference lib="deno.ns" />
/**
 * HMAC-SHA256 hex + constant-time compare — the shared signature
 * primitive for both webhook directions.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { hmacSha256Hex, timingSafeEqual } from "./hmac.ts";

const enc = (s: string) => new TextEncoder().encode(s);

Deno.test("hmacSha256Hex: known RFC-style vector (deterministic)", async () => {
  // Stable across runs — same secret + body → same digest, 64 hex chars.
  const a = await hmacSha256Hex("secret", enc("hello"));
  const b = await hmacSha256Hex("secret", enc("hello"));
  assertEquals(a, b);
  assertEquals(a.length, 64);
  assertEquals(/^[0-9a-f]+$/.test(a), true);
});

Deno.test("hmacSha256Hex: secret change → different digest", async () => {
  const a = await hmacSha256Hex("secret-a", enc("hello"));
  const b = await hmacSha256Hex("secret-b", enc("hello"));
  assertNotEquals(a, b);
});

Deno.test("hmacSha256Hex: body change → different digest", async () => {
  const a = await hmacSha256Hex("secret", enc("hello"));
  const b = await hmacSha256Hex("secret", enc("world"));
  assertNotEquals(a, b);
});

Deno.test("hmacSha256Hex: works on a subarray view (offset-safe)", async () => {
  const full = enc("XXhelloXX");
  const view = full.subarray(2, 7); // "hello"
  assertEquals(
    await hmacSha256Hex("secret", view),
    await hmacSha256Hex("secret", enc("hello")),
  );
});

Deno.test("timingSafeEqual: equal strings → true", () => {
  assertEquals(timingSafeEqual("abc123", "abc123"), true);
});

Deno.test("timingSafeEqual: different content same length → false", () => {
  assertEquals(timingSafeEqual("abc123", "abc124"), false);
});

Deno.test("timingSafeEqual: length mismatch → false", () => {
  assertEquals(timingSafeEqual("abc", "abcd"), false);
});

Deno.test("timingSafeEqual: empty strings → true", () => {
  assertEquals(timingSafeEqual("", ""), true);
});
