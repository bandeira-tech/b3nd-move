/// <reference lib="deno.ns" />

import { assert, assertEquals, assertThrows } from "@std/assert";
import { decodeUriList, encodeUriList } from "./uri-list.ts";

Deno.test("encodeUriList → decodeUriList round-trip — single URI", () => {
  const uris = ["mutable://app/foo"];
  assertEquals(decodeUriList(encodeUriList(uris)), uris);
});

Deno.test("encodeUriList → decodeUriList round-trip — multiple URIs", () => {
  const uris = [
    "mutable://app/foo",
    "https://example.com/path?q=1",
    "b3nd://proto/v1/Thing/abc",
  ];
  assertEquals(decodeUriList(encodeUriList(uris)), uris);
});

Deno.test("encodeUriList → decodeUriList round-trip — unicode in URIs", () => {
  const uris = [
    "mutable://app/café",
    "mutable://app/日本語",
    "mutable://app/🚀",
  ];
  assertEquals(decodeUriList(encodeUriList(uris)), uris);
});

Deno.test("encodeUriList produces url-safe base64 (no +, /, =)", () => {
  // Construct a list whose bytes are likely to land on +, /, or = under
  // standard base64. Many URIs in sequence is enough.
  const uris = Array.from({ length: 32 }, (_, i) => `mutable://app/item${i}`);
  const encoded = encodeUriList(uris);
  assert(!encoded.includes("+"), "should not contain '+'");
  assert(!encoded.includes("/"), "should not contain '/'");
  assert(!encoded.includes("="), "should not contain '='");
});

Deno.test("encodeUriList rejects empty list", () => {
  assertThrows(() => encodeUriList([]), TypeError);
});

Deno.test("encodeUriList rejects empty / non-string entries", () => {
  assertThrows(() => encodeUriList([""]), TypeError);
  assertThrows(
    () => encodeUriList(["good", null as unknown as string]),
    TypeError,
  );
});

Deno.test("encodeUriList rejects URIs over 65535 bytes", () => {
  assertThrows(() => encodeUriList(["x".repeat(70000)]), RangeError);
});

Deno.test("decodeUriList rejects malformed base64", () => {
  assertThrows(() => decodeUriList("not!valid!base64"), TypeError);
});

Deno.test("decodeUriList rejects truncated length prefix", () => {
  // One byte where two are needed for the u16 length prefix.
  const encoded = encodeUriList(["a"]);
  // Truncate the encoded string mid-frame.
  const truncated = encoded.slice(0, 1);
  assertThrows(() => decodeUriList(truncated), TypeError);
});

Deno.test("decodeUriList enforces maxCount", () => {
  const uris = Array.from({ length: 50 }, (_, i) => `u${i}`);
  const encoded = encodeUriList(uris);
  assertThrows(
    () => decodeUriList(encoded, { maxCount: 10 }),
    TypeError,
    "maxCount",
  );
});

Deno.test("decodeUriList rejects empty input", () => {
  // base64 of zero bytes.
  assertThrows(() => decodeUriList(""), TypeError);
});

Deno.test("encodeUriList → decodeUriList — large but reasonable list", () => {
  const uris = Array.from(
    { length: 500 },
    (_, i) => `mutable://app/items/${i}`,
  );
  assertEquals(decodeUriList(encodeUriList(uris)), uris);
});
