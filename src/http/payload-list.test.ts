/// <reference lib="deno.ns" />

import { assertEquals, assertThrows } from "@std/assert";
import { decodePayloads, encodePayloads } from "./payload-list.ts";

const enc = new TextEncoder();

function bytes(s: string): Uint8Array {
  return enc.encode(s);
}

Deno.test("encodePayloads → decodePayloads round-trip — single payload", () => {
  const ps = [bytes("hello")];
  const got = decodePayloads(encodePayloads(ps));
  assertEquals(got.length, 1);
  assertEquals(got[0], ps[0]);
});

Deno.test("encodePayloads → decodePayloads round-trip — many payloads", () => {
  const ps = [
    bytes("a"),
    bytes("bb"),
    bytes("ccc"),
    new Uint8Array([0, 1, 2, 3, 0xff]),
    bytes(""),
    bytes("the quick brown fox"),
  ];
  const got = decodePayloads(encodePayloads(ps));
  assertEquals(got.length, ps.length);
  for (let i = 0; i < ps.length; i++) {
    assertEquals(got[i], ps[i]);
  }
});

Deno.test("encodePayloads — empty list produces empty body", () => {
  const out = encodePayloads([]);
  assertEquals(out.length, 0);
});

Deno.test("decodePayloads — empty body decodes to empty list", () => {
  assertEquals(decodePayloads(new Uint8Array(0)), []);
});

Deno.test("encodePayloads — preserves empty payload (length=0)", () => {
  const ps = [bytes("a"), bytes(""), bytes("b")];
  const got = decodePayloads(encodePayloads(ps));
  assertEquals(got.length, 3);
  assertEquals(got[1].length, 0);
});

Deno.test("decodePayloads — rejects truncated length prefix", () => {
  // 3 bytes where 4 are needed for the u32 length prefix.
  assertThrows(
    () => decodePayloads(new Uint8Array([0, 0, 0])),
    TypeError,
    "Truncated payload length prefix",
  );
});

Deno.test("decodePayloads — rejects truncated payload body", () => {
  // Length prefix says 10 bytes, but only 2 follow.
  const buf = new Uint8Array([0, 0, 0, 10, 0xaa, 0xbb]);
  assertThrows(
    () => decodePayloads(buf),
    TypeError,
    "Truncated payload body",
  );
});

Deno.test("decodePayloads — enforces maxCount", () => {
  const ps = Array.from({ length: 50 }, (_, i) => bytes(`p${i}`));
  const buf = encodePayloads(ps);
  assertThrows(
    () => decodePayloads(buf, { maxCount: 10 }),
    TypeError,
    "maxCount",
  );
});

Deno.test("decodePayloads — enforces maxPayloadBytes", () => {
  const ps = [bytes("x".repeat(1000))];
  const buf = encodePayloads(ps);
  assertThrows(
    () => decodePayloads(buf, { maxPayloadBytes: 100 }),
    TypeError,
    "maxPayloadBytes",
  );
});

Deno.test("decodePayloads — slices are views, not copies", () => {
  // Mutating the source bytes should affect the decoded view.
  const buf = encodePayloads([bytes("hello")]);
  const [out] = decodePayloads(buf);
  // Modify the source where the payload bytes live.
  buf[4] = 0x58; // 'X' — first byte of the payload after the 4-byte length
  assertEquals(out[0], 0x58);
});

Deno.test("encodePayloads → decodePayloads — large but reasonable list", () => {
  const ps = Array.from({ length: 200 }, (_, i) => bytes(`payload-${i}`));
  const got = decodePayloads(encodePayloads(ps));
  assertEquals(got.length, ps.length);
  for (let i = 0; i < ps.length; i++) {
    assertEquals(got[i], ps[i]);
  }
});
