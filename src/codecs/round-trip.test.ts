/// <reference lib="deno.ns" />
/**
 * Codec round-trip property: `decode(req(payload)) ≈ payload`, and
 * `encode(payload)` produces a response a `decode` on the other facet
 * can re-ingest as the same payload.
 *
 * This is the contract that justifies the codec abstraction — wire up
 * a codec on both facets and PUT-then-GET preserves the bytes.
 */

import { assertEquals } from "@std/assert";
import type { Output } from "@bandeira-tech/b3nd-core/types";
import type { Codec } from "./codec.ts";
import { json } from "./json.ts";
import { text } from "./text.ts";
import { raw } from "./raw.ts";
import { field } from "./field.ts";

const URI = "mutable://app/x";

/** Run a payload through `encode` → wire → `decode` and return what came out. */
async function roundTrip(codec: Codec, payload: unknown): Promise<unknown> {
  const req = new Request("http://test/encode", {});
  const init = await codec.encode(req, [URI, payload] as Output);
  const headers = new Headers(init.headers);
  const ct = headers.get("Content-Type") ?? "application/octet-stream";
  const wireReq = new Request("http://test/decode", {
    method: "POST",
    headers: { "Content-Type": ct },
    body: init.body,
  });
  return await codec.decode(wireReq);
}

Deno.test("json — round-trips objects, arrays, scalars, null", async () => {
  const c = json();
  for (
    const payload of [
      { a: 1, b: "two", c: [true, false] },
      [1, 2, 3],
      "hello",
      42,
      null,
    ]
  ) {
    assertEquals(await roundTrip(c, payload), payload);
  }
});

Deno.test("text — round-trips strings, default text/plain", async () => {
  const c = text();
  assertEquals(await roundTrip(c, "hello there"), "hello there");
  assertEquals(await roundTrip(c, ""), "");
});

Deno.test("text — fixed content-type carried through encode", async () => {
  const c = text("text/markdown");
  const init = await c.encode(
    new Request("http://test"),
    [URI, "# heading"],
  );
  assertEquals(new Headers(init.headers).get("Content-Type"), "text/markdown");
});

Deno.test("raw — bytes survive the round trip", async () => {
  const c = raw("application/octet-stream");
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
  const out = await roundTrip(c, bytes);
  assertEquals(out instanceof Uint8Array, true);
  assertEquals(out as Uint8Array, bytes);
});

Deno.test("field — bytes + content-type survive the round trip", async () => {
  const c = field("bytes", { contentTypeField: "contentType" });
  const original = {
    bytes: new Uint8Array([1, 2, 3, 4]),
    contentType: "image/png",
  };
  const out = await roundTrip(c, original) as typeof original;
  assertEquals(out.bytes instanceof Uint8Array, true);
  assertEquals(out.bytes, original.bytes);
  assertEquals(out.contentType, original.contentType);
});

Deno.test("field — defaultContentType fills in when payload lacks it", async () => {
  const c = field("bytes", { defaultContentType: "image/png" });
  const init = await c.encode(
    new Request("http://test"),
    [URI, { bytes: new Uint8Array([1, 2, 3]) }],
  );
  assertEquals(new Headers(init.headers).get("Content-Type"), "image/png");
});

Deno.test("field — payload contentTypeField wins over default", async () => {
  const c = field("bytes", {
    contentTypeField: "ct",
    defaultContentType: "application/octet-stream",
  });
  const init = await c.encode(
    new Request("http://test"),
    [URI, { bytes: new Uint8Array([1]), ct: "image/jpeg" }],
  );
  assertEquals(new Headers(init.headers).get("Content-Type"), "image/jpeg");
});

Deno.test("field — encode throws when no content-type available", async () => {
  const c = field("bytes", { contentTypeField: "ct" });
  let threw = false;
  try {
    await c.encode(
      new Request("http://test"),
      [URI, { bytes: new Uint8Array([1]) }],
    );
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
