/// <reference lib="deno.ns" />
/**
 * @module
 * Tests for `mcpResourcePerSlot` — byte-faithful, idiomatic MCP codec.
 *
 * TDD plan covers all 12 cases from the task-15 brief:
 *  1. encodeRead: bytes → resource.blob base64-encoded
 *  2. encodeRead: string → resource.text with text/plain
 *  3. encodeRead: object → resource.text JSON-stringified with application/json
 *  4. encodeRead: stream materialized first then to blob
 *  5. encodeRead: pre-aborted signal rejects
 *  6. encodeReceive: results + outputs → resource per slot with JSON-encoded body + uri
 *  7. encodeReadResource: single Output → single ResourceContent with caller's resourceUri
 *  8. decodeReadArgs / decodeReceiveArgs: same shape as sibling codec
 *  9. decodeReadResponse: byte-faithful round-trip (bytes → encodeRead → JSON → decodeReadResponse → bytes IDENTICAL)
 * 10. decodeReadResponse: string round-trip
 * 11. decodeReadResponse: object round-trip
 * 12. decodeReceiveResponse: round-trip with encodeReceive
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { Output, ReceiveResult } from "@bandeira-tech/b3nd-core/types";
import type { McpResourceContent } from "../../mcp/codec.ts";
import { mcpResourcePerSlot } from "./resource-per-slot.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

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

// ── Case 1: encodeRead — bytes → resource.blob base64-encoded ────────────────

Deno.test(
  "encodeRead: Uint8Array payload → ResourceContent with blob (base64) and application/octet-stream",
  async () => {
    const codec = mcpResourcePerSlot();
    const bytes = new Uint8Array([10, 20, 30]);
    const outputs: Output[] = [["b3nd://foo", bytes]];
    const ctx = { signal: makeLiveSignal() };

    const content = await codec.encodeRead(outputs, ctx);

    assertEquals(content.length, 1);
    assertEquals(content[0].type, "resource");
    const item = content[0] as McpResourceContent;
    assertEquals(item.resource.uri, "b3nd://foo");
    assertEquals(item.resource.mimeType, "application/octet-stream");
    assertEquals(typeof item.resource.blob, "string");
    assertEquals(item.resource.text, undefined);
  },
);

// ── Case 2: encodeRead — string → resource.text with text/plain ──────────────

Deno.test(
  "encodeRead: string payload → ResourceContent with text and text/plain mimeType",
  async () => {
    const codec = mcpResourcePerSlot();
    const outputs: Output[] = [["b3nd://bar", "hello world"]];
    const ctx = { signal: makeLiveSignal() };

    const content = await codec.encodeRead(outputs, ctx);

    assertEquals(content.length, 1);
    const item = content[0] as McpResourceContent;
    assertEquals(item.resource.uri, "b3nd://bar");
    assertEquals(item.resource.text, "hello world");
    assertEquals(item.resource.mimeType, "text/plain");
    assertEquals(item.resource.blob, undefined);
  },
);

// ── Case 3: encodeRead — object → resource.text JSON-stringified, application/json ──

Deno.test(
  "encodeRead: object payload → ResourceContent with JSON.stringify text and application/json",
  async () => {
    const codec = mcpResourcePerSlot();
    const payload = { key: "value", n: 42 };
    const outputs: Output[] = [["b3nd://baz", payload]];
    const ctx = { signal: makeLiveSignal() };

    const content = await codec.encodeRead(outputs, ctx);

    assertEquals(content.length, 1);
    const item = content[0] as McpResourceContent;
    assertEquals(item.resource.uri, "b3nd://baz");
    assertEquals(item.resource.mimeType, "application/json");
    assertEquals(item.resource.text, JSON.stringify(payload));
    assertEquals(item.resource.blob, undefined);
  },
);

Deno.test(
  "encodeRead: null payload → ResourceContent with text 'null' and application/json",
  async () => {
    const codec = mcpResourcePerSlot();
    const outputs: Output[] = [["b3nd://nil", null]];
    const ctx = { signal: makeLiveSignal() };

    const content = await codec.encodeRead(outputs, ctx);

    assertEquals(content.length, 1);
    const item = content[0] as McpResourceContent;
    assertEquals(item.resource.uri, "b3nd://nil");
    assertEquals(item.resource.mimeType, "application/json");
    assertEquals(item.resource.text, "null");
  },
);

Deno.test(
  "encodeRead: multiple outputs → one ResourceContent per slot",
  async () => {
    const codec = mcpResourcePerSlot();
    const bytes = new Uint8Array([1, 2]);
    const outputs: Output[] = [
      ["b3nd://a", bytes],
      ["b3nd://b", "text"],
      ["b3nd://c", { x: 1 }],
    ];
    const ctx = { signal: makeLiveSignal() };

    const content = await codec.encodeRead(outputs, ctx);

    assertEquals(content.length, 3);
    assertEquals((content[0] as McpResourceContent).resource.uri, "b3nd://a");
    assertEquals((content[1] as McpResourceContent).resource.uri, "b3nd://b");
    assertEquals((content[2] as McpResourceContent).resource.uri, "b3nd://c");
  },
);

// ── Case 4: encodeRead — stream materialized to blob ─────────────────────────

Deno.test(
  "encodeRead: stream payload is materialized to Uint8Array then base64-encoded in blob",
  async () => {
    const codec = mcpResourcePerSlot();
    const bytes = new Uint8Array([42, 43, 44]);
    const outputs: Output[] = [["b3nd://stream", makeStream(bytes)]];
    const ctx = { signal: makeLiveSignal() };

    const content = await codec.encodeRead(outputs, ctx);

    assertEquals(content.length, 1);
    const item = content[0] as McpResourceContent;
    assertEquals(item.resource.mimeType, "application/octet-stream");
    assertEquals(typeof item.resource.blob, "string");
    // Decode the blob and verify byte equality:
    const bin = atob(item.resource.blob!);
    const decoded = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) decoded[i] = bin.charCodeAt(i);
    assertEquals(decoded, bytes);
  },
);

// ── Case 5: encodeRead — pre-aborted signal rejects ──────────────────────────

Deno.test(
  "encodeRead: rejects when signal is already aborted",
  async () => {
    const codec = mcpResourcePerSlot();
    const outputs: Output[] = [
      ["b3nd://x", makeStream(new Uint8Array([1]))],
    ];
    const ctx = { signal: makeAbortedSignal() };

    await assertRejects(async () => {
      await codec.encodeRead(outputs, ctx);
    });
  },
);

// ── Case 6: encodeReceive — one resource per slot, JSON body + uri ────────────

Deno.test(
  "encodeReceive: renders one ResourceContent per slot with JSON body {accepted, error} + uri",
  async () => {
    const codec = mcpResourcePerSlot();
    const outputs: Output[] = [
      ["b3nd://foo", { x: 1 }],
      ["b3nd://bar", null],
    ];
    const results: ReceiveResult[] = [
      { accepted: true },
      { accepted: false, error: "not allowed" },
    ];
    const ctx = { signal: makeLiveSignal() };

    const content = await Promise.resolve(
      codec.encodeReceive(results, outputs, ctx),
    );

    assertEquals(content.length, 2);

    const first = content[0] as McpResourceContent;
    assertEquals(first.type, "resource");
    assertEquals(first.resource.uri, "b3nd://foo");
    assertEquals(first.resource.mimeType, "application/json");
    const firstParsed = JSON.parse(first.resource.text!) as {
      accepted: boolean;
      error?: string;
    };
    assertEquals(firstParsed.accepted, true);
    assertEquals("error" in firstParsed, false);

    const second = content[1] as McpResourceContent;
    assertEquals(second.resource.uri, "b3nd://bar");
    const secondParsed = JSON.parse(second.resource.text!) as {
      accepted: boolean;
      error?: string;
    };
    assertEquals(secondParsed.accepted, false);
    assertEquals(secondParsed.error, "not allowed");
  },
);

// ── Case 7: encodeReadResource — uses CALLER's resourceUri, not output's uri ─

Deno.test(
  "encodeReadResource: uses caller's resourceUri, not the output's own URI",
  async () => {
    const codec = mcpResourcePerSlot();
    const output: Output = ["b3nd://stripped-form", { data: "val" }];
    const callerUri = "b3nd://full-caller-uri";
    const ctx = { signal: makeLiveSignal() };

    const contents = await codec.encodeReadResource(output, callerUri, ctx);

    assertEquals(contents.length, 1);
    assertEquals(contents[0].type, "resource");
    // MUST use callerUri, NOT output's own "b3nd://stripped-form"
    assertEquals(contents[0].resource.uri, callerUri);
  },
);

Deno.test(
  "encodeReadResource: bytes payload → blob with application/octet-stream",
  async () => {
    const codec = mcpResourcePerSlot();
    const bytes = new Uint8Array([7, 8, 9]);
    const output: Output = ["b3nd://resource", bytes];
    const ctx = { signal: makeLiveSignal() };

    const contents = await codec.encodeReadResource(
      output,
      "b3nd://resource",
      ctx,
    );

    assertEquals(contents[0].resource.mimeType, "application/octet-stream");
    assertEquals(typeof contents[0].resource.blob, "string");
  },
);

Deno.test(
  "encodeReadResource: string payload → text with text/plain",
  async () => {
    const codec = mcpResourcePerSlot();
    const output: Output = ["b3nd://r", "plain text"];
    const ctx = { signal: makeLiveSignal() };

    const contents = await codec.encodeReadResource(output, "b3nd://r", ctx);

    assertEquals(contents[0].resource.text, "plain text");
    assertEquals(contents[0].resource.mimeType, "text/plain");
  },
);

Deno.test(
  "encodeReadResource: object payload → JSON text with application/json",
  async () => {
    const codec = mcpResourcePerSlot();
    const payload = { nested: { a: 1 } };
    const output: Output = ["b3nd://r", payload];
    const ctx = { signal: makeLiveSignal() };

    const contents = await codec.encodeReadResource(output, "b3nd://r", ctx);

    assertEquals(contents[0].resource.mimeType, "application/json");
    assertEquals(contents[0].resource.text, JSON.stringify(payload));
  },
);

// ── Case 8: decodeReadArgs / decodeReceiveArgs ────────────────────────────────

Deno.test(
  "decodeReadArgs: extracts urls string[] from { urls: string[] }",
  () => {
    const codec = mcpResourcePerSlot();
    const result = codec.decodeReadArgs({ urls: ["b3nd://a", "b3nd://b"] });
    assertEquals(result, ["b3nd://a", "b3nd://b"]);
  },
);

Deno.test(
  "decodeReadArgs: throws TypeError when urls is missing",
  () => {
    const codec = mcpResourcePerSlot();
    assertThrows(() => codec.decodeReadArgs({ other: "field" }), TypeError);
  },
);

Deno.test(
  "decodeReadArgs: throws TypeError when urls is not an array",
  () => {
    const codec = mcpResourcePerSlot();
    assertThrows(
      () => codec.decodeReadArgs({ urls: "single-string" }),
      TypeError,
    );
  },
);

Deno.test(
  "decodeReadArgs: throws TypeError when urls contains non-strings",
  () => {
    const codec = mcpResourcePerSlot();
    assertThrows(() => codec.decodeReadArgs({ urls: [1, 2, 3] }), TypeError);
  },
);

Deno.test(
  "decodeReadArgs: throws TypeError when args is null",
  () => {
    const codec = mcpResourcePerSlot();
    assertThrows(() => codec.decodeReadArgs(null), TypeError);
  },
);

Deno.test(
  "decodeReceiveArgs: extracts messages Output[] from { messages: Output[] }",
  () => {
    const codec = mcpResourcePerSlot();
    const messages: Output[] = [["b3nd://x", { v: 1 }]];
    const result = codec.decodeReceiveArgs({ messages });
    assertEquals(result, messages);
  },
);

Deno.test(
  "decodeReceiveArgs: throws TypeError when messages is missing",
  () => {
    const codec = mcpResourcePerSlot();
    assertThrows(
      () => codec.decodeReceiveArgs({ other: "field" }),
      TypeError,
    );
  },
);

Deno.test(
  "decodeReceiveArgs: throws TypeError when messages is not an array",
  () => {
    const codec = mcpResourcePerSlot();
    assertThrows(
      () => codec.decodeReceiveArgs({ messages: "not-array" }),
      TypeError,
    );
  },
);

Deno.test(
  "decodeReceiveArgs: throws TypeError when args is null",
  () => {
    const codec = mcpResourcePerSlot();
    assertThrows(() => codec.decodeReceiveArgs(null), TypeError);
  },
);

// ── Case 9: decodeReadResponse — byte-faithful round-trip ────────────────────

Deno.test(
  "decodeReadResponse: byte-faithful round-trip — bytes → encodeRead → JSON serialize/parse → decodeReadResponse → IDENTICAL bytes",
  async () => {
    const codec = mcpResourcePerSlot();
    const originalBytes = new Uint8Array([0, 1, 127, 128, 255, 42]);
    const outputs: Output[] = [["b3nd://bytes", originalBytes]];
    const ctx = { signal: makeLiveSignal() };

    // Encode
    const encoded = await codec.encodeRead(outputs, ctx);

    // Simulate wire: JSON.stringify / JSON.parse (the MCP transport does this)
    const wireSimulated = JSON.parse(JSON.stringify(encoded)) as typeof encoded;

    // Decode
    const decoded = codec.decodeReadResponse(wireSimulated);

    assertEquals(decoded.length, 1);
    assertEquals(decoded[0][0], "b3nd://bytes");
    // Payload must be byte-identical Uint8Array:
    const payload = decoded[0][1];
    assertEquals(payload instanceof Uint8Array, true);
    assertEquals(payload as Uint8Array, originalBytes);
  },
);

// ── Case 10: decodeReadResponse — string round-trip ──────────────────────────

Deno.test(
  "decodeReadResponse: string round-trip — text payload survives encode → decode",
  async () => {
    const codec = mcpResourcePerSlot();
    const outputs: Output[] = [["b3nd://str", "hello round-trip"]];
    const ctx = { signal: makeLiveSignal() };

    const encoded = await codec.encodeRead(outputs, ctx);
    const wireSimulated = JSON.parse(
      JSON.stringify(encoded),
    ) as typeof encoded;
    const decoded = codec.decodeReadResponse(wireSimulated);

    assertEquals(decoded.length, 1);
    assertEquals(decoded[0][0], "b3nd://str");
    assertEquals(decoded[0][1], "hello round-trip");
  },
);

// ── Case 11: decodeReadResponse — object round-trip ──────────────────────────

Deno.test(
  "decodeReadResponse: object round-trip — JSON payload survives encode → decode",
  async () => {
    const codec = mcpResourcePerSlot();
    const payload = { nested: { x: 99 }, arr: [1, 2, 3] };
    const outputs: Output[] = [["b3nd://obj", payload]];
    const ctx = { signal: makeLiveSignal() };

    const encoded = await codec.encodeRead(outputs, ctx);
    const wireSimulated = JSON.parse(
      JSON.stringify(encoded),
    ) as typeof encoded;
    const decoded = codec.decodeReadResponse(wireSimulated);

    assertEquals(decoded.length, 1);
    assertEquals(decoded[0][0], "b3nd://obj");
    assertEquals(decoded[0][1], payload);
  },
);

// ── Case 12: decodeReceiveResponse — round-trip with encodeReceive ────────────

Deno.test(
  "decodeReceiveResponse: round-trip with encodeReceive — accepted + error survive",
  async () => {
    const codec = mcpResourcePerSlot();
    const outputs: Output[] = [
      ["b3nd://foo", null],
      ["b3nd://bar", null],
    ];
    const results: ReceiveResult[] = [
      { accepted: true },
      { accepted: false, error: "bad input" },
    ];
    const ctx = { signal: makeLiveSignal() };

    const content = await Promise.resolve(
      codec.encodeReceive(results, outputs, ctx),
    );
    const wireSimulated = JSON.parse(JSON.stringify(content)) as typeof content;
    const decoded = codec.decodeReceiveResponse(wireSimulated);

    assertEquals(decoded.length, 2);
    assertEquals(decoded[0].accepted, true);
    assertEquals(decoded[0].error, undefined);
    assertEquals(decoded[1].accepted, false);
    assertEquals(decoded[1].error, "bad input");
  },
);

Deno.test(
  "decodeReceiveResponse: URI from response is dropped (not in ReceiveResult)",
  async () => {
    const codec = mcpResourcePerSlot();
    const outputs: Output[] = [["b3nd://z", null]];
    const results: ReceiveResult[] = [{ accepted: true }];
    const ctx = { signal: makeLiveSignal() };

    const content = await Promise.resolve(
      codec.encodeReceive(results, outputs, ctx),
    );
    const decoded = codec.decodeReceiveResponse(content);

    assertEquals("uri" in decoded[0], false);
  },
);

// ── Custom scheduler ──────────────────────────────────────────────────────────

Deno.test("mcpResourcePerSlot: accepts custom scheduler", async () => {
  let callCount = 0;
  const scheduler = <T>(
    slots: ReadonlyArray<(signal: AbortSignal) => Promise<T>>,
    signal: AbortSignal,
  ): Promise<T[]> => {
    callCount++;
    return Promise.all(slots.map((s) => s(signal)));
  };

  const codec = mcpResourcePerSlot({ scheduler });
  const outputs: Output[] = [
    ["b3nd://a", makeStream(new Uint8Array([99]))],
  ];
  const ctx = { signal: makeLiveSignal() };

  await codec.encodeRead(outputs, ctx);
  assertEquals(callCount, 1);
});
