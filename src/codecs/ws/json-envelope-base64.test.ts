/// <reference lib="deno.ns" />
/**
 * @module
 * Tests for `wsJsonEnvelopeBase64` — byte-faithful WS codec (M1 fix).
 *
 * TDD plan covers 8 cases from the task-10 brief:
 * 1. encodeRead: Uint8Array payload → Output[] with payload replaced by { $bytes: <base64> }
 * 2. encodeRead: ReadableStream payload → materializes to Uint8Array, then base64-wraps
 * 3. encodeRead: JSON-object payload passes through unchanged
 * 4. encodeRead: pre-aborted signal rejects
 * 5. decodeReadResponse: Output[] with { $bytes } slot → Uint8Array payload
 * 6. decodeReadResponse: JSON-object payload passes through unchanged
 * 7. Full simulated wire round-trip: bytes → encodeRead → JSON.stringify → JSON.parse →
 *    decodeReadResponse → bytes is BYTE-IDENTICAL (M1 promise)
 * 8. Other methods behave identically to wsJsonEnvelope (spot tests)
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { Output, ReceiveResult } from "@bandeira-tech/b3nd-core/types";
import { wsJsonEnvelopeBase64 } from "./json-envelope-base64.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

function makeAbortedSignal(): AbortSignal {
  const ac = new AbortController();
  ac.abort();
  return ac.signal;
}

function makeLiveSignal(): AbortSignal {
  return new AbortController().signal;
}

function makeStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

// ── Case 1: encodeRead: Uint8Array → { $bytes: base64 } ─────────────────────

Deno.test("wsJsonEnvelopeBase64.encodeRead: Uint8Array payload is tagged as { $bytes: base64 }", async () => {
  const codec = wsJsonEnvelopeBase64();
  const bytes = new Uint8Array([10, 20, 30]);
  const outputs: Output[] = [["s://x", bytes]];
  const ctx = { id: "r1", signal: makeLiveSignal() };

  const result = await codec.encodeRead(outputs, ctx) as Output[];
  assertEquals(result.length, 1);
  assertEquals(result[0][0], "s://x");
  const payload = result[0][1] as Record<string, unknown>;
  assertEquals(typeof payload, "object");
  assertEquals(typeof payload["$bytes"], "string");
  // verify it decodes back to original bytes
  const decoded = atob(payload["$bytes"] as string);
  const recovered = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) recovered[i] = decoded.charCodeAt(i);
  assertEquals(recovered, bytes);
});

Deno.test("wsJsonEnvelopeBase64.encodeRead: null payload passes through unchanged", async () => {
  const codec = wsJsonEnvelopeBase64();
  const outputs: Output[] = [["s://a", null]];
  const ctx = { id: "r0", signal: makeLiveSignal() };
  const result = await codec.encodeRead(outputs, ctx) as Output[];
  assertEquals(result[0][1], null);
});

// ── Case 2: encodeRead: ReadableStream → materialize → base64-wrap ──────────

Deno.test("wsJsonEnvelopeBase64.encodeRead: ReadableStream payload is materialized then base64-wrapped", async () => {
  const codec = wsJsonEnvelopeBase64();
  const bytes = new Uint8Array([1, 2, 3, 255]);
  const outputs: Output[] = [["s://stream", makeStream(bytes)]];
  const ctx = { id: "r2", signal: makeLiveSignal() };

  const result = await codec.encodeRead(outputs, ctx) as Output[];
  assertEquals(result.length, 1);
  assertEquals(result[0][0], "s://stream");
  const payload = result[0][1] as Record<string, unknown>;
  assertEquals(typeof payload["$bytes"], "string");
  const decoded = atob(payload["$bytes"] as string);
  const recovered = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) recovered[i] = decoded.charCodeAt(i);
  assertEquals(recovered, bytes);
});

Deno.test("wsJsonEnvelopeBase64.encodeRead: materializes multiple slots", async () => {
  const codec = wsJsonEnvelopeBase64();
  const outputs: Output[] = [
    ["s://a", makeStream(new Uint8Array([1, 2]))],
    ["s://b", new Uint8Array([3, 4])],
  ];
  const ctx = { id: "r3", signal: makeLiveSignal() };
  const result = await codec.encodeRead(outputs, ctx) as Output[];
  assertEquals(result.length, 2);
  assertEquals(typeof (result[0][1] as Record<string, unknown>)["$bytes"], "string");
  assertEquals(typeof (result[1][1] as Record<string, unknown>)["$bytes"], "string");
});

// ── Case 3: encodeRead: JSON-object passes through unchanged ─────────────────

Deno.test("wsJsonEnvelopeBase64.encodeRead: JSON-object payload passes through unchanged", async () => {
  const codec = wsJsonEnvelopeBase64();
  const obj = { hello: "world", n: 42 };
  const outputs: Output[] = [["s://json", obj]];
  const ctx = { id: "r4", signal: makeLiveSignal() };

  const result = await codec.encodeRead(outputs, ctx) as Output[];
  assertEquals(result.length, 1);
  assertEquals(result[0][1], obj);
  // Must NOT have a $bytes key
  const payload = result[0][1] as Record<string, unknown>;
  assertEquals("$bytes" in payload, false);
});

Deno.test("wsJsonEnvelopeBase64.encodeRead: string payload passes through unchanged", async () => {
  const codec = wsJsonEnvelopeBase64();
  const outputs: Output[] = [["s://str", "hello"]];
  const ctx = { id: "r5", signal: makeLiveSignal() };
  const result = await codec.encodeRead(outputs, ctx) as Output[];
  assertEquals(result[0][1], "hello");
});

Deno.test("wsJsonEnvelopeBase64.encodeRead: number payload passes through unchanged", async () => {
  const codec = wsJsonEnvelopeBase64();
  const outputs: Output[] = [["s://num", 99]];
  const ctx = { id: "r6", signal: makeLiveSignal() };
  const result = await codec.encodeRead(outputs, ctx) as Output[];
  assertEquals(result[0][1], 99);
});

// ── Case 4: encodeRead with pre-aborted signal rejects ──────────────────────

Deno.test("wsJsonEnvelopeBase64.encodeRead: pre-aborted signal rejects", async () => {
  const codec = wsJsonEnvelopeBase64();
  const outputs: Output[] = [["s://x", makeStream(new Uint8Array([1, 2, 3]))]];
  const ctx = { id: "r7", signal: makeAbortedSignal() };
  await assertRejects(
    () => codec.encodeRead(outputs, ctx) as Promise<unknown>,
  );
});

// ── Case 5: decodeReadResponse: { $bytes } → Uint8Array ─────────────────────

Deno.test("wsJsonEnvelopeBase64.decodeReadResponse: { $bytes } slot is decoded to Uint8Array", () => {
  const codec = wsJsonEnvelopeBase64();
  const bytes = new Uint8Array([10, 20, 30]);
  // Build the base64 manually
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  const b64 = btoa(s);

  const data = [["s://x", { "$bytes": b64 }]] as unknown;
  const result = codec.decodeReadResponse(data);
  assertEquals(result.length, 1);
  assertEquals(result[0][0], "s://x");
  const payload = result[0][1];
  assertEquals(payload instanceof Uint8Array, true);
  assertEquals(payload, bytes);
});

Deno.test("wsJsonEnvelopeBase64.decodeReadResponse: multiple slots, mixed tagged and plain", () => {
  const codec = wsJsonEnvelopeBase64();
  const bytes = new Uint8Array([5, 6]);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  const b64 = btoa(s);

  const data = [
    ["s://bytes", { "$bytes": b64 }],
    ["s://plain", { key: "val" }],
  ] as unknown;
  const result = codec.decodeReadResponse(data);
  assertEquals(result.length, 2);
  assertEquals(result[0][1] instanceof Uint8Array, true);
  assertEquals(result[0][1], bytes);
  assertEquals(result[1][1], { key: "val" });
});

// ── Case 6: decodeReadResponse: JSON-object passes through unchanged ─────────

Deno.test("wsJsonEnvelopeBase64.decodeReadResponse: JSON-object payload passes through unchanged", () => {
  const codec = wsJsonEnvelopeBase64();
  const obj = { foo: "bar" };
  const data = [["s://json", obj]] as unknown;
  const result = codec.decodeReadResponse(data);
  assertEquals(result.length, 1);
  assertEquals(result[0][1], obj);
});

Deno.test("wsJsonEnvelopeBase64.decodeReadResponse: object with $bytes but extra keys passes through unchanged", () => {
  // Object must have EXACTLY one key ($bytes) to be treated as a tag.
  // If it has extra keys, it must not be decoded.
  const codec = wsJsonEnvelopeBase64();
  const payload = { "$bytes": "aGVsbG8=", extra: "field" };
  const data = [["s://x", payload]] as unknown;
  const result = codec.decodeReadResponse(data);
  assertEquals(result[0][1], payload); // passed through
  assertEquals(result[0][1] instanceof Uint8Array, false);
});

Deno.test("wsJsonEnvelopeBase64.decodeReadResponse: null payload passes through unchanged", () => {
  const codec = wsJsonEnvelopeBase64();
  const data = [["s://x", null]] as unknown;
  const result = codec.decodeReadResponse(data);
  assertEquals(result[0][1], null);
});

// ── Case 7: Full wire round-trip — bytes are BYTE-IDENTICAL ─────────────────

Deno.test("wsJsonEnvelopeBase64: Uint8Array payload round-trips byte-faithful through JSON wire", async () => {
  const codec = wsJsonEnvelopeBase64();
  const bytes = new Uint8Array([10, 20, 30]);
  const encoded = await codec.encodeRead(
    [["s://x", bytes]],
    { id: "rt1", signal: makeLiveSignal() },
  ) as Output[];
  // Simulate the WS service: JSON.stringify + JSON.parse
  const wire = JSON.parse(JSON.stringify(encoded));
  const decoded = codec.decodeReadResponse(wire);
  assertEquals(decoded.length, 1);
  assertEquals(decoded[0][0], "s://x");
  assertEquals(decoded[0][1] instanceof Uint8Array, true);
  assertEquals(decoded[0][1], bytes); // BYTE-IDENTICAL
});

Deno.test("wsJsonEnvelopeBase64: ReadableStream round-trips byte-faithful through JSON wire", async () => {
  const codec = wsJsonEnvelopeBase64();
  const bytes = new Uint8Array([0, 127, 128, 255]);
  const encoded = await codec.encodeRead(
    [["s://rt2", makeStream(bytes)]],
    { id: "rt2", signal: makeLiveSignal() },
  ) as Output[];
  const wire = JSON.parse(JSON.stringify(encoded));
  const decoded = codec.decodeReadResponse(wire);
  assertEquals(decoded[0][1], bytes);
});

Deno.test("wsJsonEnvelopeBase64: all-zeros Uint8Array round-trips byte-faithful", async () => {
  const codec = wsJsonEnvelopeBase64();
  const bytes = new Uint8Array(16); // all zeros
  const encoded = await codec.encodeRead(
    [["s://zeros", bytes]],
    { id: "rt3", signal: makeLiveSignal() },
  ) as Output[];
  const wire = JSON.parse(JSON.stringify(encoded));
  const decoded = codec.decodeReadResponse(wire);
  assertEquals(decoded[0][1], bytes);
});

Deno.test("wsJsonEnvelopeBase64: JSON-object payload survives JSON wire unchanged", async () => {
  const codec = wsJsonEnvelopeBase64();
  const obj = { hello: "world", n: 42 };
  const encoded = await codec.encodeRead(
    [["s://json", obj]],
    { id: "rt4", signal: makeLiveSignal() },
  ) as Output[];
  const wire = JSON.parse(JSON.stringify(encoded));
  const decoded = codec.decodeReadResponse(wire);
  assertEquals(decoded[0][1], obj);
});

// ── Case 8: Other methods behave identically to wsJsonEnvelope ───────────────

Deno.test("wsJsonEnvelopeBase64: encodeReceive returns results unchanged", () => {
  const codec = wsJsonEnvelopeBase64();
  const results: ReceiveResult[] = [{ accepted: true }, { accepted: false, error: "nope" }];
  const ctx = { id: "recv1", signal: makeLiveSignal() };
  const result = codec.encodeReceive(results, ctx);
  assertEquals(result === results, true);
});

Deno.test("wsJsonEnvelopeBase64: decodeRead extracts urls from { urls: string[] }", () => {
  const codec = wsJsonEnvelopeBase64();
  const result = codec.decodeRead({ urls: ["s://a", "s://b"] });
  assertEquals(result, ["s://a", "s://b"]);
});

Deno.test("wsJsonEnvelopeBase64: decodeReceive validates Output[] shape", () => {
  const codec = wsJsonEnvelopeBase64();
  const outputs: Output[] = [["s://a", { value: 1 }]];
  const result = codec.decodeReceive(outputs);
  assertEquals(result, outputs);
});

Deno.test("wsJsonEnvelopeBase64: encodeReadRequest returns { urls }", () => {
  const codec = wsJsonEnvelopeBase64();
  const urls = ["s://a", "s://b"];
  assertEquals(codec.encodeReadRequest(urls), { urls });
});

Deno.test("wsJsonEnvelopeBase64: encodeReceiveRequest returns outputs as-is", () => {
  const codec = wsJsonEnvelopeBase64();
  const outputs: Output[] = [["s://a", { v: 1 }]];
  assertEquals(codec.encodeReceiveRequest(outputs) === outputs, true);
});

Deno.test("wsJsonEnvelopeBase64: decodeReceiveResponse returns data as-is", () => {
  const codec = wsJsonEnvelopeBase64();
  const data = [{ accepted: true }] as unknown;
  const result = codec.decodeReceiveResponse(data);
  assertEquals(result === data, true);
});

// ── Custom scheduler ──────────────────────────────────────────────────────────

Deno.test("wsJsonEnvelopeBase64: accepts custom scheduler", async () => {
  let callCount = 0;
  const scheduler = <T>(
    slots: ReadonlyArray<(signal: AbortSignal) => Promise<T>>,
    signal: AbortSignal,
  ): Promise<T[]> => {
    callCount++;
    return Promise.all(slots.map((s) => s(signal)));
  };

  const codec = wsJsonEnvelopeBase64({ scheduler });
  const outputs: Output[] = [["s://a", makeStream(new Uint8Array([99]))]];
  const ctx = { id: "custom-sched", signal: makeLiveSignal() };

  await codec.encodeRead(outputs, ctx);
  assertEquals(callCount, 1);
});
