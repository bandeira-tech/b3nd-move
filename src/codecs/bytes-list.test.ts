/// <reference lib="deno.ns" />

import { assertEquals, assertThrows } from "@std/assert";
import { decodeBytesList, encodeBytesList } from "./bytes-list.ts";

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);

// ── u16 (default) round-trips ──────────────────────────────────────

Deno.test("u16 — single slot round-trip", () => {
  const slots = [bytes("hello")];
  assertEquals(decodeBytesList(encodeBytesList(slots)), slots);
});

Deno.test("u16 — many slots round-trip", () => {
  const slots = [
    bytes("a"),
    bytes("bb"),
    bytes("ccc"),
    new Uint8Array([0, 1, 2, 0xff]),
    bytes(""), // empty is legal
    bytes("longer slot with some text"),
  ];
  const got = decodeBytesList(encodeBytesList(slots));
  assertEquals(got.length, slots.length);
  for (let i = 0; i < slots.length; i++) assertEquals(got[i], slots[i]);
});

// ── u32 round-trips ────────────────────────────────────────────────

Deno.test("u32 — round-trips when configured", () => {
  const slots = [bytes("alpha"), bytes("beta"), bytes("")];
  const buf = encodeBytesList(slots, { lenSize: 4 });
  assertEquals(decodeBytesList(buf, { lenSize: 4 }), slots);
});

Deno.test("u32 — supports slots larger than u16 limit", () => {
  // u16 caps at 65535. 70 KiB needs u32.
  const big = new Uint8Array(70 * 1024).fill(0x5a);
  assertThrows(() => encodeBytesList([big]), RangeError); // u16 default rejects
  const buf = encodeBytesList([big], { lenSize: 4 });
  const [out] = decodeBytesList(buf, { lenSize: 4 });
  assertEquals(out.length, big.length);
});

// ── boundary + framing fidelity ────────────────────────────────────

Deno.test("empty list encodes to empty buffer", () => {
  assertEquals(encodeBytesList([]).length, 0);
});

Deno.test("empty buffer decodes to empty list", () => {
  assertEquals(decodeBytesList(new Uint8Array(0)), []);
});

Deno.test("empty slot (length=0) is preserved", () => {
  const slots = [bytes("a"), bytes(""), bytes("b")];
  const got = decodeBytesList(encodeBytesList(slots));
  assertEquals(got.length, 3);
  assertEquals(got[1].length, 0);
});

// ── rejection paths ────────────────────────────────────────────────

Deno.test("u16 — encode rejects slot over 65535 bytes", () => {
  const big = new Uint8Array(70000);
  assertThrows(() => encodeBytesList([big]), RangeError);
});

Deno.test("decode rejects truncated length prefix (u16)", () => {
  assertThrows(
    () => decodeBytesList(new Uint8Array([0])),
    TypeError,
    "Truncated slot length prefix",
  );
});

Deno.test("decode rejects truncated length prefix (u32)", () => {
  assertThrows(
    () => decodeBytesList(new Uint8Array([0, 0, 0]), { lenSize: 4 }),
    TypeError,
    "Truncated slot length prefix",
  );
});

Deno.test("decode rejects truncated body", () => {
  // u16 length says 10, but only 2 bytes follow.
  const buf = new Uint8Array([0, 10, 0xaa, 0xbb]);
  assertThrows(() => decodeBytesList(buf), TypeError, "Truncated slot body");
});

Deno.test("decode enforces maxCount", () => {
  const slots = Array.from({ length: 50 }, (_, i) => bytes(`s${i}`));
  const buf = encodeBytesList(slots);
  assertThrows(
    () => decodeBytesList(buf, { maxCount: 10 }),
    TypeError,
    "maxCount",
  );
});

Deno.test("decode enforces maxBytes", () => {
  const slots = [bytes("x".repeat(1000))];
  const buf = encodeBytesList(slots);
  assertThrows(
    () => decodeBytesList(buf, { maxBytes: 100 }),
    TypeError,
    "maxBytes",
  );
});

// ── views, not copies ──────────────────────────────────────────────

Deno.test("decoded slots are views into the input buffer", () => {
  const buf = encodeBytesList([bytes("hello")]);
  const [out] = decodeBytesList(buf);
  // u16 prefix at offset 0..1; payload starts at offset 2.
  buf[2] = 0x58; // overwrite 'h' with 'X' in the source
  assertEquals(out[0], 0x58);
});
