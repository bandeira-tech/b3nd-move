/// <reference lib="deno.ns" />
import { assertEquals, assertRejects } from "@std/assert";
import type { Output } from "@bandeira-tech/b3nd-core/types";
import { httpNdjson } from "./ndjson.ts";

const codec = httpNdjson();

// ---------------------------------------------------------------------------
// encode
// ---------------------------------------------------------------------------

Deno.test("httpNdjson.encode: JSON object payload passes through as-is", async () => {
  const outputs: Output[] = [
    ["s://a", { key: "val" }],
    ["s://b", 42],
  ];
  const res = await codec.encode(outputs, {
    req: new Request("http://x/api/v1/read"),
    signal: new AbortController().signal,
  });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Content-Type"), "application/x-ndjson");
  const text = await res.text();
  const lines = text.split("\n").filter(Boolean);
  assertEquals(lines.length, 2);
  const line0 = JSON.parse(lines[0]);
  assertEquals(line0.uri, "s://a");
  assertEquals(line0.payload, { key: "val" });
  const line1 = JSON.parse(lines[1]);
  assertEquals(line1.uri, "s://b");
  assertEquals(line1.payload, 42);
});

Deno.test("httpNdjson.encode: Uint8Array payload is tagged as { $bytes: base64 }", async () => {
  const bytes = new Uint8Array([1, 2, 3, 255]);
  const outputs: Output[] = [["s://bin", bytes]];
  const res = await codec.encode(outputs, {
    req: new Request("http://x/api/v1/read"),
    signal: new AbortController().signal,
  });
  assertEquals(res.status, 200);
  const text = await res.text();
  const lines = text.split("\n").filter(Boolean);
  assertEquals(lines.length, 1);
  const line = JSON.parse(lines[0]);
  assertEquals(line.uri, "s://bin");
  // payload must be the tagged object, not a lossy {0:n,…} shape
  assertEquals(typeof line.payload, "object");
  assertEquals(typeof line.payload.$bytes, "string");
  // the $bytes value must be a valid base64 that round-trips to original bytes
  const decoded = atob(line.payload.$bytes);
  const recovered = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) recovered[i] = decoded.charCodeAt(i);
  assertEquals(recovered, bytes);
});

Deno.test("httpNdjson.encode: ReadableStream payload is materialized before line-encoding", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([10, 20, 30]));
      c.close();
    },
  });
  const outputs: Output[] = [["s://stream", stream]];
  const res = await codec.encode(outputs, {
    req: new Request("http://x/api/v1/read"),
    signal: new AbortController().signal,
  });
  assertEquals(res.status, 200);
  const text = await res.text();
  const lines = text.split("\n").filter(Boolean);
  assertEquals(lines.length, 1);
  const line = JSON.parse(lines[0]);
  assertEquals(line.uri, "s://stream");
  // materialized bytes tagged as $bytes
  assertEquals(typeof line.payload.$bytes, "string");
  const decoded = atob(line.payload.$bytes);
  const recovered = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) recovered[i] = decoded.charCodeAt(i);
  assertEquals(recovered, new Uint8Array([10, 20, 30]));
});

Deno.test("httpNdjson.encode: abort during stream materialization rejects", async () => {
  const ac = new AbortController();
  ac.abort();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([1]));
      c.close();
    },
  });
  await assertRejects(async () =>
    await codec.encode([["s://x", stream]], {
      req: new Request("http://x/api/v1/read"),
      signal: ac.signal,
    })
  );
});

// ---------------------------------------------------------------------------
// decode
// ---------------------------------------------------------------------------

Deno.test("httpNdjson.decode: parses NDJSON request body into Output[]", async () => {
  const lines = [
    JSON.stringify({ uri: "s://a", payload: { msg: "hello" } }),
    JSON.stringify({ uri: "s://b", payload: 99 }),
  ].join("\n") + "\n";
  const req = new Request("http://x/api/v1/receive", {
    method: "POST",
    body: lines,
    headers: { "Content-Type": "application/x-ndjson" },
  });
  const outputs = await codec.decode(req);
  assertEquals(outputs.length, 2);
  assertEquals(outputs[0][0], "s://a");
  assertEquals(outputs[0][1], { msg: "hello" });
  assertEquals(outputs[1][0], "s://b");
  assertEquals(outputs[1][1], 99);
});

Deno.test("httpNdjson.decode: $bytes tagged payloads are restored to Uint8Array", async () => {
  const original = new Uint8Array([5, 10, 15]);
  let bin = "";
  for (const b of original) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  const line = JSON.stringify({ uri: "s://bin", payload: { $bytes: b64 } }) +
    "\n";
  const req = new Request("http://x/api/v1/receive", {
    method: "POST",
    body: line,
    headers: { "Content-Type": "application/x-ndjson" },
  });
  const outputs = await codec.decode(req);
  assertEquals(outputs.length, 1);
  assertEquals(outputs[0][0], "s://bin");
  assertEquals(outputs[0][1], original);
});

// ---------------------------------------------------------------------------
// decodeReadResponse
// ---------------------------------------------------------------------------

Deno.test("httpNdjson.decodeReadResponse: parses NDJSON response body into Output[]", async () => {
  const lines = [
    JSON.stringify({ uri: "s://c", payload: "text-val" }),
    JSON.stringify({ uri: "s://d", payload: null }),
  ].join("\n") + "\n";
  const res = new Response(lines, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
  const outputs = await codec.decodeReadResponse(res);
  assertEquals(outputs.length, 2);
  assertEquals(outputs[0][0], "s://c");
  assertEquals(outputs[0][1], "text-val");
  assertEquals(outputs[1][0], "s://d");
  assertEquals(outputs[1][1], null);
});

Deno.test("httpNdjson.decodeReadResponse: $bytes tagged payloads are restored to Uint8Array", async () => {
  const original = new Uint8Array([255, 0, 128]);
  let bin = "";
  for (const b of original) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  const line = JSON.stringify({ uri: "s://bytes", payload: { $bytes: b64 } }) +
    "\n";
  const res = new Response(line, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
  const outputs = await codec.decodeReadResponse(res);
  assertEquals(outputs.length, 1);
  assertEquals(outputs[0][0], "s://bytes");
  assertEquals(outputs[0][1], original);
});

// ---------------------------------------------------------------------------
// End-to-end round-trip
// ---------------------------------------------------------------------------

Deno.test("httpNdjson round-trip: encode then decodeReadResponse restores Uint8Array payloads", async () => {
  const original = new TextEncoder().encode("round-trip me");
  const outputs: Output[] = [["s://rt", original]];
  const res = await codec.encode(outputs, {
    req: new Request("http://x/api/v1/read"),
    signal: new AbortController().signal,
  });
  const decoded = await codec.decodeReadResponse(res);
  assertEquals(decoded.length, 1);
  assertEquals(decoded[0][0], "s://rt");
  assertEquals(decoded[0][1], original);
});
