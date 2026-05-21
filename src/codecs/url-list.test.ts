/// <reference lib="deno.ns" />

import { assert, assertEquals, assertThrows } from "@std/assert";
import { decodeUrlList, encodeUrlList } from "./url-list.ts";

Deno.test("encodeUrlList → decodeUrlList round-trip — single URL", () => {
  const urls = ["mutable://app/foo"];
  assertEquals(decodeUrlList(encodeUrlList(urls)), urls);
});

Deno.test("encodeUrlList → decodeUrlList round-trip — multiple URLs", () => {
  const urls = [
    "mutable://app/foo",
    "https://example.com/path?q=1",
    "b3nd://proto/v1/Thing/abc",
  ];
  assertEquals(decodeUrlList(encodeUrlList(urls)), urls);
});

Deno.test("encodeUrlList → decodeUrlList round-trip — unicode in URLs", () => {
  const urls = [
    "mutable://app/café",
    "mutable://app/日本語",
    "mutable://app/🚀",
  ];
  assertEquals(decodeUrlList(encodeUrlList(urls)), urls);
});

Deno.test("encodeUrlList → decodeUrlList round-trip — opaque query strings", () => {
  // The framer treats query strings as locator content, not as parseable
  // structure — they fly through opaquely for the persistence layer.
  const urls = [
    "mutable://app/list?after=cursor-xyz&limit=50",
    "mutable://app/search?q=hello%20world&sort=desc",
    "https://example.com/x?weird=a&b&=&%",
  ];
  assertEquals(decodeUrlList(encodeUrlList(urls)), urls);
});

Deno.test("encodeUrlList produces url-safe base64 (no +, /, =)", () => {
  // Construct a list whose bytes are likely to land on +, /, or = under
  // standard base64. Many URLs in sequence is enough.
  const urls = Array.from({ length: 32 }, (_, i) => `mutable://app/item${i}`);
  const encoded = encodeUrlList(urls);
  assert(!encoded.includes("+"), "should not contain '+'");
  assert(!encoded.includes("/"), "should not contain '/'");
  assert(!encoded.includes("="), "should not contain '='");
});

Deno.test("encodeUrlList rejects empty list", () => {
  assertThrows(() => encodeUrlList([]), TypeError);
});

Deno.test("encodeUrlList rejects empty / non-string entries", () => {
  assertThrows(() => encodeUrlList([""]), TypeError);
  assertThrows(
    () => encodeUrlList(["good", null as unknown as string]),
    TypeError,
  );
});

Deno.test("encodeUrlList rejects URLs over 65535 bytes", () => {
  assertThrows(() => encodeUrlList(["x".repeat(70000)]), RangeError);
});

Deno.test("decodeUrlList rejects malformed base64", () => {
  assertThrows(() => decodeUrlList("not!valid!base64"), TypeError);
});

Deno.test("decodeUrlList rejects truncated length prefix", () => {
  // One byte where two are needed for the u16 length prefix.
  const encoded = encodeUrlList(["a"]);
  // Truncate the encoded string mid-frame.
  const truncated = encoded.slice(0, 1);
  assertThrows(() => decodeUrlList(truncated), TypeError);
});

Deno.test("decodeUrlList enforces maxCount", () => {
  const urls = Array.from({ length: 50 }, (_, i) => `u${i}`);
  const encoded = encodeUrlList(urls);
  assertThrows(
    () => decodeUrlList(encoded, { maxCount: 10 }),
    TypeError,
    "maxCount",
  );
});

Deno.test("decodeUrlList rejects empty input", () => {
  // base64 of zero bytes.
  assertThrows(() => decodeUrlList(""), TypeError);
});

Deno.test("encodeUrlList → decodeUrlList — large but reasonable list", () => {
  const urls = Array.from(
    { length: 500 },
    (_, i) => `mutable://app/items/${i}`,
  );
  assertEquals(decodeUrlList(encodeUrlList(urls)), urls);
});
