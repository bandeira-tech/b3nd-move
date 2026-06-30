/// <reference lib="deno.ns" />
/**
 * @module
 * Tests for `wsJsonEnvelope` — today's baked WS behavior made explicit.
 *
 * TDD plan covers all 12 cases from the task-8 brief:
 * 1. encodeRead materializes stream payloads (ReadableStream → Uint8Array)
 * 2. encodeRead with already-aborted signal rejects
 * 3. encodeReceive returns results unchanged
 * 4. decodeRead extracts urls from { urls }; throws TypeError on invalid shape
 * 5. decodeRead throws TypeError on null/undefined payload
 * 6. decodeReceive validates Output[] shape; throws on invalid
 * 7. encodeReadRequest(urls) returns { urls }
 * 8. encodeReceiveRequest(outputs) returns outputs (same reference or equivalent)
 * 9. decodeReadResponse(data) returns data as-is (cast to Output[])
 * 10. decodeReceiveResponse(data) returns data as-is
 * 11. Round-trip: encodeReadRequest([uri]) → decodeRead → returns [uri]
 * 12. Round-trip simulating wire: encodeRead → JSON.stringify → JSON.parse →
 *     decodeReadResponse → bytes appear as the lossy {0:n,…} shape
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { Output, ReceiveResult } from "@bandeira-tech/b3nd-core/types";
import { wsJsonEnvelope } from "./json-envelope.ts";

// ── helpers ─────────────────────────────────────────────────────────────

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

// ── Case 1: encodeRead materializes stream payloads ──────────────────────

Deno.test("encodeRead: materializes ReadableStream payload to Uint8Array", async () => {
  const codec = wsJsonEnvelope();
  const bytes = new Uint8Array([10, 20, 30]);
  const outputs: Output[] = [["s://a", makeStream(bytes)]];
  const ctx = { id: "r1", signal: makeLiveSignal() };

  const result = await codec.encodeRead(outputs, ctx) as Output[];
  assertEquals(result.length, 1);
  assertEquals(result[0][0], "s://a");
  const payload = result[0][1];
  assertEquals(payload instanceof Uint8Array, true);
  assertEquals(Array.from(payload as Uint8Array), [10, 20, 30]);
});

Deno.test("encodeRead: passes through non-stream payloads unchanged", async () => {
  const codec = wsJsonEnvelope();
  const outputs: Output[] = [["s://a", { some: "json" }]];
  const ctx = { id: "r1", signal: makeLiveSignal() };

  const result = await codec.encodeRead(outputs, ctx) as Output[];
  assertEquals(result.length, 1);
  assertEquals(result[0][1], { some: "json" });
});

Deno.test("encodeRead: passes through null payload unchanged", async () => {
  const codec = wsJsonEnvelope();
  const outputs: Output[] = [["s://a", null]];
  const ctx = { id: "r1", signal: makeLiveSignal() };

  const result = await codec.encodeRead(outputs, ctx) as Output[];
  assertEquals(result[0][1], null);
});

Deno.test("encodeRead: materializes multiple streams in parallel", async () => {
  const codec = wsJsonEnvelope();
  const outputs: Output[] = [
    ["s://a", makeStream(new Uint8Array([1, 2]))],
    ["s://b", makeStream(new Uint8Array([3, 4]))],
  ];
  const ctx = { id: "r2", signal: makeLiveSignal() };

  const result = await codec.encodeRead(outputs, ctx) as Output[];
  assertEquals(result.length, 2);
  assertEquals(Array.from(result[0][1] as Uint8Array), [1, 2]);
  assertEquals(Array.from(result[1][1] as Uint8Array), [3, 4]);
});

// ── Case 2: encodeRead with already-aborted signal rejects ──────────────

Deno.test("encodeRead: rejects when signal is already aborted", async () => {
  const codec = wsJsonEnvelope();
  const outputs: Output[] = [["s://a", makeStream(new Uint8Array([1, 2, 3]))]];
  const ctx = { id: "r3", signal: makeAbortedSignal() };

  await assertRejects(
    () => codec.encodeRead(outputs, ctx) as Promise<unknown>,
  );
});

// ── Case 3: encodeReceive returns results unchanged ──────────────────────

Deno.test("encodeReceive: returns results unchanged", () => {
  const codec = wsJsonEnvelope();
  const results: ReceiveResult[] = [
    { accepted: true },
    { accepted: false, error: "nope" },
  ];
  const ctx = { id: "recv1", signal: makeLiveSignal() };

  const result = codec.encodeReceive(results, ctx);
  assertEquals(result, results);
});

Deno.test("encodeReceive: returns exact same reference", () => {
  const codec = wsJsonEnvelope();
  const results: ReceiveResult[] = [{ accepted: true }];
  const ctx = { id: "recv2", signal: makeLiveSignal() };

  const result = codec.encodeReceive(results, ctx);
  // Same reference — no copy
  assertEquals(result === results, true);
});

// ── Case 4: decodeRead extracts urls, throws TypeError on invalid ────────

Deno.test("decodeRead: extracts urls from { urls: string[] }", () => {
  const codec = wsJsonEnvelope();
  const result = codec.decodeRead({ urls: ["s://a", "s://b"] });
  assertEquals(result, ["s://a", "s://b"]);
});

Deno.test("decodeRead: throws TypeError when urls is missing", () => {
  const codec = wsJsonEnvelope();
  assertThrows(
    () => codec.decodeRead({ other: "field" }),
    TypeError,
  );
});

Deno.test("decodeRead: throws TypeError when urls is not an array", () => {
  const codec = wsJsonEnvelope();
  assertThrows(
    () => codec.decodeRead({ urls: 42 }),
    TypeError,
  );
});

Deno.test("decodeRead: throws TypeError when urls array is empty", () => {
  const codec = wsJsonEnvelope();
  assertThrows(
    () => codec.decodeRead({ urls: [] }),
    TypeError,
  );
});

Deno.test("decodeRead: throws TypeError when urls contains non-strings", () => {
  const codec = wsJsonEnvelope();
  assertThrows(
    () => codec.decodeRead({ urls: [1, 2, 3] }),
    TypeError,
  );
});

// ── Case 5: decodeRead throws TypeError on null/undefined payload ────────

Deno.test("decodeRead: throws TypeError on null payload", () => {
  const codec = wsJsonEnvelope();
  assertThrows(
    () => codec.decodeRead(null),
    TypeError,
  );
});

Deno.test("decodeRead: throws TypeError on undefined payload", () => {
  const codec = wsJsonEnvelope();
  assertThrows(
    () => codec.decodeRead(undefined),
    TypeError,
  );
});

// ── Case 6: decodeReceive validates Output[] shape ───────────────────────

Deno.test("decodeReceive: returns valid Output[] as-is", () => {
  const codec = wsJsonEnvelope();
  const outputs: Output[] = [["s://a", { value: 1 }]];
  const result = codec.decodeReceive(outputs);
  assertEquals(result, outputs);
});

Deno.test("decodeReceive: throws TypeError on non-array input", () => {
  const codec = wsJsonEnvelope();
  assertThrows(
    () => codec.decodeReceive({ not: "an-array" }),
    TypeError,
  );
});

Deno.test("decodeReceive: throws TypeError on empty array", () => {
  const codec = wsJsonEnvelope();
  assertThrows(
    () => codec.decodeReceive([]),
    TypeError,
  );
});

Deno.test("decodeReceive: throws TypeError when slot lacks string URI", () => {
  const codec = wsJsonEnvelope();
  assertThrows(
    () => codec.decodeReceive([[42, "payload"]]),
    TypeError,
  );
});

Deno.test("decodeReceive: throws TypeError when element is not [uri, payload] tuple", () => {
  const codec = wsJsonEnvelope();
  assertThrows(
    () => codec.decodeReceive(["s://a"]),
    TypeError,
  );
});

// ── Case 7: encodeReadRequest returns { urls } ───────────────────────────

Deno.test("encodeReadRequest: returns { urls } wrapper", () => {
  const codec = wsJsonEnvelope();
  const urls = ["s://a", "s://b"];
  const result = codec.encodeReadRequest(urls);
  assertEquals(result, { urls });
});

Deno.test("encodeReadRequest: urls field is the same reference", () => {
  const codec = wsJsonEnvelope();
  const urls = ["s://a"];
  const result = codec.encodeReadRequest(urls) as { urls: string[] };
  assertEquals(result.urls === urls, true);
});

// ── Case 8: encodeReceiveRequest returns outputs ─────────────────────────

Deno.test("encodeReceiveRequest: returns outputs as-is", () => {
  const codec = wsJsonEnvelope();
  const outputs: Output[] = [["s://a", { v: 1 }]];
  const result = codec.encodeReceiveRequest(outputs);
  assertEquals(result, outputs);
});

Deno.test("encodeReceiveRequest: returns exact same reference", () => {
  const codec = wsJsonEnvelope();
  const outputs: Output[] = [["s://a", null]];
  const result = codec.encodeReceiveRequest(outputs);
  assertEquals(result === outputs, true);
});

// ── Case 9: decodeReadResponse returns data as-is ────────────────────────

Deno.test("decodeReadResponse: returns data as Output[] without transformation", () => {
  const codec = wsJsonEnvelope();
  const data = [["s://a", { parsed: true }]] as unknown;
  const result = codec.decodeReadResponse(data);
  assertEquals(result, data as Output[]);
  assertEquals(result === data, true);
});

// ── Case 10: decodeReceiveResponse returns data as-is ────────────────────

Deno.test("decodeReceiveResponse: returns data as ReceiveResult[] without transformation", () => {
  const codec = wsJsonEnvelope();
  const data = [{ accepted: true }] as unknown;
  const result = codec.decodeReceiveResponse(data);
  assertEquals(result, data as ReceiveResult[]);
  assertEquals(result === data, true);
});

// ── Case 11: Round-trip encodeReadRequest → decodeRead ───────────────────

Deno.test("round-trip: encodeReadRequest → decodeRead returns original urls", () => {
  const codec = wsJsonEnvelope();
  const urls = ["s://one", "s://two", "s://three"];
  const payload = codec.encodeReadRequest(urls);
  const decoded = codec.decodeRead(payload);
  assertEquals(decoded, urls);
});

// ── Case 12: Round-trip through JSON wire (lossy bytes shape) ────────────

Deno.test(
  "round-trip: encodeRead → JSON.stringify → JSON.parse → decodeReadResponse yields lossy {0:n,…} for Uint8Array",
  async () => {
    // This test PINS the documented WS KNOWN LIMITATION:
    // Uint8Array payloads serialized through JSON.stringify emerge as
    // {0:n,1:n,…} object shapes. This is intentional behavior for the
    // json-envelope codec. Any future change to byte encoding (e.g.
    // base64) will fail this assertion and force a coordinated update.
    const codec = wsJsonEnvelope();
    const bytes = new Uint8Array([10, 20, 30]);
    const outputs: Output[] = [["s://a", makeStream(bytes)]];
    const ctx = { id: "wire1", signal: makeLiveSignal() };

    const materialized = await codec.encodeRead(outputs, ctx) as Output[];
    // Simulate the WS service JSON.stringify + client JSON.parse:
    const wireData = JSON.parse(JSON.stringify(materialized));
    // Now the client calls decodeReadResponse on the parsed data:
    const decoded = codec.decodeReadResponse(wireData);
    assertEquals(decoded.length, 1);
    assertEquals(decoded[0][0], "s://a");
    // The Uint8Array became the lossy {0:10,1:20,2:30} shape:
    const payload = decoded[0][1] as Record<string, number>;
    assertEquals(typeof payload, "object");
    assertEquals(Array.isArray(payload), false);
    assertEquals(payload["0"], 10);
    assertEquals(payload["1"], 20);
    assertEquals(payload["2"], 30);
  },
);

Deno.test(
  "round-trip: non-bytes payload survives JSON wire unchanged",
  async () => {
    const codec = wsJsonEnvelope();
    const outputs: Output[] = [["s://b", { hello: "world", n: 42 }]];
    const ctx = { id: "wire2", signal: makeLiveSignal() };

    const materialized = await codec.encodeRead(outputs, ctx) as Output[];
    const wireData = JSON.parse(JSON.stringify(materialized));
    const decoded = codec.decodeReadResponse(wireData);
    assertEquals(decoded.length, 1);
    assertEquals(decoded[0][1], { hello: "world", n: 42 });
  },
);

// ── Custom scheduler ─────────────────────────────────────────────────────

Deno.test("wsJsonEnvelope: accepts custom scheduler", async () => {
  let callCount = 0;
  const scheduler = <T>(
    slots: ReadonlyArray<(signal: AbortSignal) => Promise<T>>,
    signal: AbortSignal,
  ): Promise<T[]> => {
    callCount++;
    return Promise.all(slots.map((s) => s(signal)));
  };

  const codec = wsJsonEnvelope({ scheduler });
  const outputs: Output[] = [["s://a", makeStream(new Uint8Array([99]))]];
  const ctx = { id: "custom-sched", signal: makeLiveSignal() };

  await codec.encodeRead(outputs, ctx);
  assertEquals(callCount, 1);
});
