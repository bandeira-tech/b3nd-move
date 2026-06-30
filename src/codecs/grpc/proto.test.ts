/// <reference lib="deno.ns" />
/**
 * @module
 * Tests for `grpcProto` — today's baked gRPC behavior made explicit.
 *
 * All seven cases from the task-11 brief:
 * 1. encodeRead bytes round-trip (decodeReadResponse(encodeRead([uri, bytes])) === [uri, bytes])
 * 2. encodeRead JSON-object round-trip
 * 3. encodeRead stream materialization (stream → materialized → proto encoded → decoded as Uint8Array)
 * 4. encodeRead pre-aborted signal rejects
 * 5. encodeReceive / decodeReceiveResponse round-trip (accepted=true and false/error)
 * 6. encodeReadRequest / decodeRead round-trip
 * 7. encodeReceiveRequest / decodeReceive round-trip (bytes + non-bytes payloads)
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { Output, ReceiveResult } from "@bandeira-tech/b3nd-core/types";
import { grpcProto } from "./proto.ts";

// ── helpers ──────────────────────────────────────────────────────────────

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

// ── Case 1: encodeRead bytes round-trip ──────────────────────────────────

Deno.test("encodeRead / decodeReadResponse: Uint8Array payload round-trips faithfully", async () => {
  const codec = grpcProto();
  const bytes = new Uint8Array([10, 20, 30, 40]);
  const outputs: Output[] = [["s://a", bytes]];
  const ctx = { signal: makeLiveSignal() };

  const response = await codec.encodeRead(outputs, ctx);
  const decoded = codec.decodeReadResponse(response);

  assertEquals(decoded.length, 1);
  assertEquals(decoded[0][0], "s://a");
  const payload = decoded[0][1] as Uint8Array;
  assertEquals(payload instanceof Uint8Array, true);
  assertEquals(Array.from(payload), [10, 20, 30, 40]);
});

Deno.test("encodeRead / decodeReadResponse: multiple byte slots round-trip", async () => {
  const codec = grpcProto();
  const outputs: Output[] = [
    ["s://a", new Uint8Array([1, 2])],
    ["s://b", new Uint8Array([3, 4, 5])],
  ];
  const ctx = { signal: makeLiveSignal() };

  const response = await codec.encodeRead(outputs, ctx);
  const decoded = codec.decodeReadResponse(response);

  assertEquals(decoded.length, 2);
  assertEquals(decoded[0][0], "s://a");
  assertEquals(Array.from(decoded[0][1] as Uint8Array), [1, 2]);
  assertEquals(decoded[1][0], "s://b");
  assertEquals(Array.from(decoded[1][1] as Uint8Array), [3, 4, 5]);
});

// ── Case 2: encodeRead JSON-object round-trip ─────────────────────────────

Deno.test("encodeRead / decodeReadResponse: JSON-serializable payload round-trips faithfully", async () => {
  const codec = grpcProto();
  const payload = { hello: "world", n: 42, nested: { flag: true } };
  const outputs: Output[] = [["s://json", payload]];
  const ctx = { signal: makeLiveSignal() };

  const response = await codec.encodeRead(outputs, ctx);
  const decoded = codec.decodeReadResponse(response);

  assertEquals(decoded.length, 1);
  assertEquals(decoded[0][0], "s://json");
  assertEquals(decoded[0][1], payload);
});

Deno.test("encodeRead / decodeReadResponse: null payload round-trips faithfully", async () => {
  const codec = grpcProto();
  const outputs: Output[] = [["s://null", null]];
  const ctx = { signal: makeLiveSignal() };

  const response = await codec.encodeRead(outputs, ctx);
  const decoded = codec.decodeReadResponse(response);

  assertEquals(decoded.length, 1);
  assertEquals(decoded[0][0], "s://null");
  // null serializes as "" (empty JSON) which decodes back to undefined
  // per decodePayload: json.length > 0 ? JSON.parse(json) : undefined
  // JSON.stringify(null) === "null" → length > 0 → JSON.parse("null") === null
  assertEquals(decoded[0][1], null);
});

Deno.test("encodeRead / decodeReadResponse: string payload round-trips faithfully", async () => {
  const codec = grpcProto();
  const outputs: Output[] = [["s://str", "hello gRPC"]];
  const ctx = { signal: makeLiveSignal() };

  const response = await codec.encodeRead(outputs, ctx);
  const decoded = codec.decodeReadResponse(response);

  assertEquals(decoded[0][1], "hello gRPC");
});

// ── Case 3: encodeRead stream materialization (M3 fix) ───────────────────

Deno.test("encodeRead: materializes ReadableStream payload to Uint8Array before proto encoding", async () => {
  const codec = grpcProto();
  const bytes = new Uint8Array([100, 200, 255]);
  const outputs: Output[] = [["s://stream", makeStream(bytes)]];
  const ctx = { signal: makeLiveSignal() };

  const response = await codec.encodeRead(outputs, ctx);
  const decoded = codec.decodeReadResponse(response);

  assertEquals(decoded.length, 1);
  assertEquals(decoded[0][0], "s://stream");
  const payload = decoded[0][1] as Uint8Array;
  // Must be Uint8Array (payloadIsBinary=true path), not the lossy {0:n,…} from
  // JSON.stringify(stream) === "{}" (M3 stealth bug).
  assertEquals(payload instanceof Uint8Array, true);
  assertEquals(Array.from(payload), [100, 200, 255]);
});

Deno.test("encodeRead: materializes multiple stream payloads in parallel", async () => {
  const codec = grpcProto();
  const outputs: Output[] = [
    ["s://a", makeStream(new Uint8Array([1, 2]))],
    ["s://b", makeStream(new Uint8Array([3, 4, 5]))],
  ];
  const ctx = { signal: makeLiveSignal() };

  const response = await codec.encodeRead(outputs, ctx);
  const decoded = codec.decodeReadResponse(response);

  assertEquals(decoded.length, 2);
  assertEquals(Array.from(decoded[0][1] as Uint8Array), [1, 2]);
  assertEquals(Array.from(decoded[1][1] as Uint8Array), [3, 4, 5]);
});

Deno.test("encodeRead: passes through non-stream payloads unchanged", async () => {
  const codec = grpcProto();
  const outputs: Output[] = [["s://plain", { key: "value" }]];
  const ctx = { signal: makeLiveSignal() };

  const response = await codec.encodeRead(outputs, ctx);
  const decoded = codec.decodeReadResponse(response);

  assertEquals(decoded[0][1], { key: "value" });
});

// ── Case 4: encodeRead pre-aborted signal rejects ────────────────────────

Deno.test("encodeRead: rejects when signal is already aborted (stream payload)", async () => {
  const codec = grpcProto();
  const outputs: Output[] = [["s://a", makeStream(new Uint8Array([1, 2, 3]))]];
  const ctx = { signal: makeAbortedSignal() };

  await assertRejects(
    async () => await codec.encodeRead(outputs, ctx),
  );
});

// ── Case 5: encodeReceive / decodeReceiveResponse round-trip ─────────────

Deno.test("encodeReceive / decodeReceiveResponse: accepted=true round-trip", async () => {
  const codec = grpcProto();
  const results: ReceiveResult[] = [{ accepted: true }];
  const ctx = { signal: makeLiveSignal() };

  const response = await codec.encodeReceive(results, ctx);
  const decoded = codec.decodeReceiveResponse(response);

  assertEquals(decoded.length, 1);
  assertEquals(decoded[0].accepted, true);
  assertEquals(decoded[0].error, undefined);
});

Deno.test("encodeReceive / decodeReceiveResponse: accepted=false with error round-trip", async () => {
  const codec = grpcProto();
  const results: ReceiveResult[] = [
    { accepted: false, error: "unauthorized" },
  ];
  const ctx = { signal: makeLiveSignal() };

  const response = await codec.encodeReceive(results, ctx);
  const decoded = codec.decodeReceiveResponse(response);

  assertEquals(decoded.length, 1);
  assertEquals(decoded[0].accepted, false);
  assertEquals(decoded[0].error, "unauthorized");
});

Deno.test("encodeReceive / decodeReceiveResponse: mixed results round-trip", async () => {
  const codec = grpcProto();
  const results: ReceiveResult[] = [
    { accepted: true },
    { accepted: false, error: "conflict" },
    { accepted: true },
  ];
  const ctx = { signal: makeLiveSignal() };

  const response = await codec.encodeReceive(results, ctx);
  const decoded = codec.decodeReceiveResponse(response);

  assertEquals(decoded.length, 3);
  assertEquals(decoded[0].accepted, true);
  assertEquals(decoded[1].accepted, false);
  assertEquals(decoded[1].error, "conflict");
  assertEquals(decoded[2].accepted, true);
});

Deno.test("encodeReceive / decodeReceiveResponse: empty results round-trip", async () => {
  const codec = grpcProto();
  const ctx = { signal: makeLiveSignal() };

  const response = await codec.encodeReceive([], ctx);
  const decoded = codec.decodeReceiveResponse(response);

  assertEquals(decoded, []);
});

// ── Case 6: encodeReadRequest / decodeRead round-trip ────────────────────

Deno.test("encodeReadRequest / decodeRead: single URL round-trips", () => {
  const codec = grpcProto();
  const urls = ["s://one"];

  const req = codec.encodeReadRequest(urls);
  const decoded = codec.decodeRead(req);

  assertEquals(decoded, urls);
});

Deno.test("encodeReadRequest / decodeRead: multiple URLs round-trip", () => {
  const codec = grpcProto();
  const urls = ["s://one", "s://two", "s://three"];

  const req = codec.encodeReadRequest(urls);
  const decoded = codec.decodeRead(req);

  assertEquals(decoded, urls);
});

Deno.test("encodeReadRequest / decodeRead: URLs with query parameters round-trip", () => {
  const codec = grpcProto();
  const urls = ["s://a?fn=transform&x=1", "s://b"];

  const req = codec.encodeReadRequest(urls);
  const decoded = codec.decodeRead(req);

  assertEquals(decoded, urls);
});

// ── Case 7: encodeReceiveRequest / decodeReceive round-trip ──────────────

Deno.test("encodeReceiveRequest / decodeReceive: Uint8Array payload round-trips", () => {
  const codec = grpcProto();
  const outputs: Output[] = [["s://a", new Uint8Array([1, 2, 3])]];

  const req = codec.encodeReceiveRequest(outputs);
  const decoded = codec.decodeReceive(req);

  assertEquals(decoded.length, 1);
  assertEquals(decoded[0][0], "s://a");
  const payload = decoded[0][1] as Uint8Array;
  assertEquals(payload instanceof Uint8Array, true);
  assertEquals(Array.from(payload), [1, 2, 3]);
});

Deno.test("encodeReceiveRequest / decodeReceive: JSON payload round-trips", () => {
  const codec = grpcProto();
  const outputs: Output[] = [["s://b", { event: "click", x: 10 }]];

  const req = codec.encodeReceiveRequest(outputs);
  const decoded = codec.decodeReceive(req);

  assertEquals(decoded.length, 1);
  assertEquals(decoded[0][0], "s://b");
  assertEquals(decoded[0][1], { event: "click", x: 10 });
});

Deno.test("encodeReceiveRequest / decodeReceive: mixed bytes + non-bytes round-trip", () => {
  const codec = grpcProto();
  const outputs: Output[] = [
    ["s://a", new Uint8Array([10, 20])],
    ["s://b", { some: "json" }],
    ["s://c", new Uint8Array([30, 40, 50])],
  ];

  const req = codec.encodeReceiveRequest(outputs);
  const decoded = codec.decodeReceive(req);

  assertEquals(decoded.length, 3);
  assertEquals(Array.from(decoded[0][1] as Uint8Array), [10, 20]);
  assertEquals(decoded[1][1], { some: "json" });
  assertEquals(Array.from(decoded[2][1] as Uint8Array), [30, 40, 50]);
});

Deno.test("encodeReceiveRequest / decodeReceive: empty array round-trips", () => {
  const codec = grpcProto();

  const req = codec.encodeReceiveRequest([]);
  const decoded = codec.decodeReceive(req);

  assertEquals(decoded, []);
});

// ── Custom scheduler ──────────────────────────────────────────────────────

Deno.test("grpcProto: accepts custom scheduler injected at construction", async () => {
  let callCount = 0;
  const scheduler = <T>(
    slots: ReadonlyArray<(signal: AbortSignal) => Promise<T>>,
    signal: AbortSignal,
  ): Promise<T[]> => {
    callCount++;
    return Promise.all(slots.map((s) => s(signal)));
  };

  const codec = grpcProto({ scheduler });
  const outputs: Output[] = [["s://a", makeStream(new Uint8Array([99]))]];
  const ctx = { signal: makeLiveSignal() };

  await codec.encodeRead(outputs, ctx);
  assertEquals(callCount, 1);
});
