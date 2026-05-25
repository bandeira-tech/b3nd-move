/// <reference lib="deno.ns" />
/**
 * field codec: bytes-plus-metadata envelope ↔ raw body with a host-
 * controlled content-type. Round-trip codec — PUT through decode then
 * GET through encode must reproduce the same wire bytes.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { field } from "./field.ts";

const REQ = new Request("http://x");

// ── encode ──

Deno.test("field.encode: reads bytes from named field, uses defaultContentType", async () => {
  const c = field("bytes", { defaultContentType: "image/png" });
  const init = await c.encode(REQ, [
    "u",
    { bytes: new Uint8Array([1, 2, 3]) },
  ]);
  assertEquals(Array.from(init.body as Uint8Array), [1, 2, 3]);
  assertEquals(
    (init.headers as Record<string, string>)["Content-Type"],
    "image/png",
  );
});

Deno.test("field.encode: content-type from payload field overrides default", async () => {
  const c = field("bytes", {
    contentTypeField: "ct",
    defaultContentType: "image/png",
  });
  const init = await c.encode(REQ, [
    "u",
    { bytes: new Uint8Array([0]), ct: "image/jpeg" },
  ]);
  assertEquals(
    (init.headers as Record<string, string>)["Content-Type"],
    "image/jpeg",
  );
});

Deno.test("field.encode: empty payload ct falls back to default", async () => {
  const c = field("bytes", {
    contentTypeField: "ct",
    defaultContentType: "image/png",
  });
  const init = await c.encode(REQ, [
    "u",
    { bytes: new Uint8Array([0]), ct: "" },
  ]);
  assertEquals(
    (init.headers as Record<string, string>)["Content-Type"],
    "image/png",
  );
});

Deno.test("field.encode: non-object payload → TypeError", () => {
  assertThrows(
    () =>
      void field("bytes").encode(REQ, [
        "u",
        "not-an-object" as unknown as object,
      ]),
    TypeError,
    "payload must be an object",
  );
});

Deno.test("field.encode: missing named field → TypeError", () => {
  assertThrows(
    () => void field("bytes").encode(REQ, ["u", { other: 1 }]),
    TypeError,
    `missing field "bytes"`,
  );
});

Deno.test("field.encode: no content-type anywhere → TypeError", () => {
  // No defaultContentType + no contentTypeField → cannot resolve.
  assertThrows(
    () =>
      void field("bytes").encode(REQ, ["u", { bytes: new Uint8Array([0]) }]),
    TypeError,
    "no content-type",
  );
});

// ── decode ──

Deno.test("field.decode: yields { [name]: bytes }", async () => {
  const c = field("bytes");
  const req = new Request("http://x", {
    method: "POST",
    body: new Uint8Array([1, 2]),
  });
  const out = await c.decode(req) as Record<string, unknown>;
  assertEquals(Array.from(out.bytes as Uint8Array), [1, 2]);
});

Deno.test("field.decode: writes request Content-Type into contentTypeField", async () => {
  const c = field("bytes", { contentTypeField: "ct" });
  const req = new Request("http://x", {
    method: "POST",
    body: new Uint8Array([1]),
    headers: { "Content-Type": "image/jpeg" },
  });
  const out = await c.decode(req) as Record<string, unknown>;
  assertEquals(out.ct, "image/jpeg");
});

Deno.test("field round-trip: decode(req).encode(...) reproduces wire bytes", async () => {
  const c = field("bytes", {
    contentTypeField: "ct",
    defaultContentType: "application/octet-stream",
  });
  const original = new Uint8Array([7, 7, 7]);
  const req = new Request("http://x", {
    method: "POST",
    body: original,
    headers: { "Content-Type": "image/webp" },
  });
  const payload = await c.decode(req);
  const init = await c.encode(REQ, ["u", payload]);
  assertEquals(Array.from(init.body as Uint8Array), [7, 7, 7]);
  assertEquals(
    (init.headers as Record<string, string>)["Content-Type"],
    "image/webp",
  );
});
