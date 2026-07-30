/// <reference lib="deno.ns" />

import { assertEquals, assertThrows } from "@std/assert";
import type { Output } from "@bandeira-tech/b3nd-core/types";
import { decodeOutputsFrame, encodeOutputsFrame } from "./outputs-frame.ts";

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);

// ── round-trips ─────────────────────────────────────────────────────

Deno.test("round-trip: single raw-bytes slot", () => {
  const outs: Output[] = [["mutable://x", new Uint8Array([1, 2, 3, 255])]];
  const buf = encodeOutputsFrame(outs);
  const got = decodeOutputsFrame(buf);
  assertEquals(got.length, 1);
  assertEquals(got[0][0], "mutable://x");
  assertEquals(Array.from(got[0][1] as Uint8Array), [1, 2, 3, 255]);
});

Deno.test("round-trip: many slots, raw bytes preserved verbatim", () => {
  const outs: Output[] = [
    ["mutable://a", bytes("payload-a")],
    ["mutable://b", new Uint8Array([0, 0, 0, 0])],
    ["mutable://c", bytes("")], // empty payload is legal
  ];
  const buf = encodeOutputsFrame(outs);
  const got = decodeOutputsFrame(buf);
  assertEquals(got.length, 3);
  for (let i = 0; i < outs.length; i++) {
    assertEquals(got[i][0], outs[i][0]);
    assertEquals(
      Array.from(got[i][1] as Uint8Array),
      Array.from(outs[i][1] as Uint8Array),
    );
  }
});

Deno.test("round-trip: JSON-fallback slot for non-bytes payload", () => {
  const outs: Output[] = [["mutable://j", { echo: "x", n: 42 }]];
  const buf = encodeOutputsFrame(outs);
  const got = decodeOutputsFrame(buf);
  assertEquals(got, [["mutable://j", { echo: "x", n: 42 }]]);
});

Deno.test("round-trip: null payload via JSON-fallback (miss sentinel)", () => {
  const outs: Output[] = [["mutable://miss", null]];
  const buf = encodeOutputsFrame(outs);
  const got = decodeOutputsFrame(buf);
  assertEquals(got, [["mutable://miss", null]]);
});

Deno.test("round-trip: undefined payload encodes as the null miss sentinel", () => {
  const outs: Output[] = [["mutable://absent", undefined]];
  const buf = encodeOutputsFrame(outs);
  assertEquals(decodeOutputsFrame(buf), [["mutable://absent", null]]);
});

Deno.test("decode: zero-length JSON-fallback slot reads as the null miss sentinel", () => {
  const uri = "mutable://absent";
  const u = bytes(uri);
  const buf = new Uint8Array(1 + 2 + u.length + 4);
  const view = new DataView(buf.buffer);
  buf[0] = 0;
  view.setUint16(1, u.length, false);
  buf.set(u, 3);
  view.setUint32(3 + u.length, 0, false);
  assertEquals(decodeOutputsFrame(buf), [[uri, null]]);
});

Deno.test("an empty raw-bytes payload stays bytes, not the miss sentinel", () => {
  const buf = encodeOutputsFrame([["mutable://empty", new Uint8Array(0)]]);
  const [[, payload]] = decodeOutputsFrame(buf);
  assertEquals(payload instanceof Uint8Array, true);
  assertEquals((payload as Uint8Array).length, 0);
});

Deno.test("round-trip: mixed bytes + JSON slots, order preserved", () => {
  const outs: Output[] = [
    ["mutable://1", new Uint8Array([10, 20])],
    ["mutable://2", { hello: "world" }],
    ["mutable://3", new Uint8Array([0xfe, 0xed, 0xfa, 0xce])],
    ["mutable://4", null],
  ];
  const buf = encodeOutputsFrame(outs);
  const got = decodeOutputsFrame(buf);
  assertEquals(got[0][0], "mutable://1");
  assertEquals(Array.from(got[0][1] as Uint8Array), [10, 20]);
  assertEquals(got[1], ["mutable://2", { hello: "world" }]);
  assertEquals(got[2][0], "mutable://3");
  assertEquals(Array.from(got[2][1] as Uint8Array), [0xfe, 0xed, 0xfa, 0xce]);
  assertEquals(got[3], ["mutable://4", null]);
});

Deno.test("empty list encodes to empty buffer; empty buffer decodes to []", () => {
  assertEquals(encodeOutputsFrame([]).length, 0);
  assertEquals(decodeOutputsFrame(new Uint8Array(0)), []);
});

Deno.test("decoded raw-bytes payload is a view into the input buffer", () => {
  const buf = encodeOutputsFrame([[
    "mutable://v",
    new Uint8Array([0xaa, 0xbb]),
  ]]);
  const [, payload] = decodeOutputsFrame(buf)[0];
  // Mutate the source buffer at the payload offset; the view must follow.
  // Frame: [flag=1][uri-len=11 hi][uri-len=11 lo][...11 uri bytes...][payload-len 4 bytes][payload...]
  const payloadOff = 1 + 2 + 11 + 4;
  buf[payloadOff] = 0x77;
  assertEquals((payload as Uint8Array)[0], 0x77);
});

// ── rejections ──────────────────────────────────────────────────────

Deno.test("encode: rejects non-string URI", () => {
  assertThrows(
    () =>
      encodeOutputsFrame([
        [null as unknown as string, new Uint8Array([1])],
      ]),
    TypeError,
    "URI must be a non-empty string",
  );
});

Deno.test("encode: rejects empty URI", () => {
  assertThrows(
    () => encodeOutputsFrame([["", new Uint8Array([1])]]),
    TypeError,
  );
});

Deno.test("encode: rejects URI over 65535 bytes", () => {
  const longUri = "u://" + "x".repeat(70000);
  assertThrows(
    () => encodeOutputsFrame([[longUri, new Uint8Array([1])]]),
    RangeError,
  );
});

Deno.test("encode: maxCount enforced", () => {
  const outs: Output[] = Array.from(
    { length: 5 },
    (_, i): Output => [`mutable://${i}`, new Uint8Array([i])],
  );
  assertThrows(
    () => encodeOutputsFrame(outs, { maxCount: 3 }),
    RangeError,
    "maxCount",
  );
});

Deno.test("decode: rejects invalid flag byte", () => {
  // flag=2 (illegal), uri-len=1, "x", payload-len=0
  const buf = new Uint8Array([2, 0, 1, 0x78, 0, 0, 0, 0]);
  assertThrows(() => decodeOutputsFrame(buf), TypeError, "Invalid slot flag");
});

Deno.test("decode: rejects truncated URI length", () => {
  // flag=1, then only 1 byte of u16 URI length
  assertThrows(
    () => decodeOutputsFrame(new Uint8Array([1, 0])),
    TypeError,
    "Truncated URI length",
  );
});

Deno.test("decode: rejects truncated URI body", () => {
  // flag=1, uri-len=5, but only 2 URI bytes follow
  assertThrows(
    () => decodeOutputsFrame(new Uint8Array([1, 0, 5, 0x61, 0x62])),
    TypeError,
    "Truncated URI body",
  );
});

Deno.test("decode: rejects truncated payload length", () => {
  // flag=1, uri-len=1, "x", then only 2 bytes of u32 payload length
  assertThrows(
    () => decodeOutputsFrame(new Uint8Array([1, 0, 1, 0x78, 0, 0])),
    TypeError,
    "Truncated payload length",
  );
});

Deno.test("decode: rejects truncated payload body", () => {
  // flag=1, uri-len=1, "x", payload-len=10, but only 2 payload bytes
  const buf = new Uint8Array([1, 0, 1, 0x78, 0, 0, 0, 10, 0xaa, 0xbb]);
  assertThrows(
    () => decodeOutputsFrame(buf),
    TypeError,
    "Truncated payload body",
  );
});

Deno.test("decode: rejects empty URI in slot", () => {
  // flag=1, uri-len=0, payload-len=0
  assertThrows(
    () => decodeOutputsFrame(new Uint8Array([1, 0, 0, 0, 0, 0, 0])),
    TypeError,
    "Empty URI",
  );
});

Deno.test("decode: rejects invalid UTF-8 in URI", () => {
  // flag=1, uri-len=1, 0xff (invalid UTF-8 start byte), payload-len=0
  assertThrows(
    () => decodeOutputsFrame(new Uint8Array([1, 0, 1, 0xff, 0, 0, 0, 0])),
    TypeError,
    "Invalid UTF-8 in URI",
  );
});

Deno.test("decode: rejects invalid JSON in fallback payload", () => {
  // flag=0, uri-len=1, "x", payload-len=3, "not"
  const buf = new Uint8Array([
    0,
    0,
    1,
    0x78,
    0,
    0,
    0,
    3,
    0x6e,
    0x6f,
    0x74,
  ]);
  assertThrows(() => decodeOutputsFrame(buf), TypeError, "Invalid JSON");
});

Deno.test("decode: enforces maxCount", () => {
  const outs: Output[] = Array.from(
    { length: 5 },
    (_, i): Output => [`u://${i}`, new Uint8Array([i])],
  );
  const buf = encodeOutputsFrame(outs);
  assertThrows(
    () => decodeOutputsFrame(buf, { maxCount: 3 }),
    TypeError,
    "maxCount",
  );
});

Deno.test("decode: enforces maxPayloadBytes", () => {
  const outs: Output[] = [["u://x", new Uint8Array(1000)]];
  const buf = encodeOutputsFrame(outs);
  assertThrows(
    () => decodeOutputsFrame(buf, { maxPayloadBytes: 100 }),
    TypeError,
    "maxPayloadBytes",
  );
});
