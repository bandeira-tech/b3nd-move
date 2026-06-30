/// <reference lib="deno.ns" />
/**
 * @module
 * Tests for `mcpTextJsonStringify` — today's baked MCP behavior made explicit.
 *
 * TDD plan covers all 8 cases from the task-13 brief:
 * 1. encodeRead: Output[] with bytes payload → JSON text (Uint8Array lossy-encoded)
 * 2. encodeRead: pre-aborted signal rejects
 * 3. encodeReceive: results + outputs → text with {uri, accepted, error} per slot
 * 4. encodeReadResource: single Output → ResourceContent shape
 * 5. decodeReadArgs: {urls} extraction; invalid throws TypeError
 * 6. decodeReceiveArgs: {messages} extraction; invalid throws TypeError
 * 7. decodeReadResponse: round-trip with encodeRead
 * 8. decodeReceiveResponse: round-trip with encodeReceive
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { Output, ReceiveResult } from "@bandeira-tech/b3nd-core/types";
import { mcpTextJsonStringify } from "./text-json-stringify.ts";

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

// ── Case 1: encodeRead with bytes payload → JSON text (lossy Uint8Array) ─

Deno.test(
  "encodeRead: Output[] with bytes payload → single TextContent with JSON-stringified array",
  async () => {
    const codec = mcpTextJsonStringify();
    const bytes = new Uint8Array([10, 20, 30]);
    const outputs: Output[] = [["b3nd://foo", bytes]];
    const ctx = { signal: makeLiveSignal() };

    const content = await codec.encodeRead(outputs, ctx);

    assertEquals(content.length, 1);
    assertEquals(content[0].type, "text");
    const item = content[0] as { type: "text"; text: string };
    // Must use JSON.stringify with null, 2 (today's exact formatting):
    const expected = JSON.stringify(
      [{ uri: "b3nd://foo", payload: bytes }],
      null,
      2,
    );
    assertEquals(item.text, expected);
  },
);

Deno.test(
  "encodeRead: stream payload is materialized to Uint8Array before JSON.stringify",
  async () => {
    const codec = mcpTextJsonStringify();
    const bytes = new Uint8Array([1, 2, 3]);
    const outputs: Output[] = [["b3nd://bar", makeStream(bytes)]];
    const ctx = { signal: makeLiveSignal() };

    const content = await codec.encodeRead(outputs, ctx);

    assertEquals(content.length, 1);
    assertEquals(content[0].type, "text");
    const item = content[0] as { type: "text"; text: string };
    const parsed = JSON.parse(item.text) as Array<
      { uri: string; payload: unknown }
    >;
    assertEquals(parsed.length, 1);
    assertEquals(parsed[0].uri, "b3nd://bar");
    // After JSON.stringify, Uint8Array emerges as the lossy {0:n,1:n,…} shape:
    const payload = parsed[0].payload as Record<string, number>;
    assertEquals(typeof payload, "object");
    assertEquals(Array.isArray(payload), false);
    assertEquals(payload["0"], 1);
    assertEquals(payload["1"], 2);
    assertEquals(payload["2"], 3);
  },
);

Deno.test(
  "encodeRead: non-stream JSON payload passes through unchanged",
  async () => {
    const codec = mcpTextJsonStringify();
    const outputs: Output[] = [["b3nd://baz", { hello: "world" }]];
    const ctx = { signal: makeLiveSignal() };

    const content = await codec.encodeRead(outputs, ctx);

    assertEquals(content.length, 1);
    const item = content[0] as { type: "text"; text: string };
    const parsed = JSON.parse(item.text) as Array<
      { uri: string; payload: unknown }
    >;
    assertEquals(parsed[0].payload, { hello: "world" });
  },
);

Deno.test(
  "encodeRead: multiple outputs are all included in the JSON array",
  async () => {
    const codec = mcpTextJsonStringify();
    const outputs: Output[] = [
      ["b3nd://a", { x: 1 }],
      ["b3nd://b", { x: 2 }],
    ];
    const ctx = { signal: makeLiveSignal() };

    const content = await codec.encodeRead(outputs, ctx);

    const item = content[0] as { type: "text"; text: string };
    const parsed = JSON.parse(item.text) as Array<
      { uri: string; payload: unknown }
    >;
    assertEquals(parsed.length, 2);
    assertEquals(parsed[0].uri, "b3nd://a");
    assertEquals(parsed[1].uri, "b3nd://b");
  },
);

// ── Case 2: encodeRead with pre-aborted signal rejects ───────────────────

Deno.test(
  "encodeRead: rejects when signal is already aborted",
  async () => {
    const codec = mcpTextJsonStringify();
    const outputs: Output[] = [["b3nd://x", makeStream(new Uint8Array([1]))]];
    const ctx = { signal: makeAbortedSignal() };

    await assertRejects(
      async () => {
        await codec.encodeRead(outputs, ctx);
      },
    );
  },
);

// ── Case 3: encodeReceive → text with {uri, accepted, error} per slot ────

Deno.test(
  "encodeReceive: renders {uri, accepted, error} per slot from results + outputs",
  async () => {
    const codec = mcpTextJsonStringify();
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

    assertEquals(content.length, 1);
    assertEquals(content[0].type, "text");
    const item = content[0] as { type: "text"; text: string };
    const parsed = JSON.parse(item.text) as Array<{
      uri: string;
      accepted: boolean;
      error?: string;
    }>;
    assertEquals(parsed.length, 2);
    assertEquals(parsed[0].uri, "b3nd://foo");
    assertEquals(parsed[0].accepted, true);
    assertEquals(parsed[0].error, undefined);
    assertEquals(parsed[1].uri, "b3nd://bar");
    assertEquals(parsed[1].accepted, false);
    assertEquals(parsed[1].error, "not allowed");
  },
);

Deno.test(
  "encodeReceive: accepted slot has no error field in JSON",
  async () => {
    const codec = mcpTextJsonStringify();
    const outputs: Output[] = [["b3nd://ok", null]];
    const results: ReceiveResult[] = [{ accepted: true }];
    const ctx = { signal: makeLiveSignal() };

    const content = await Promise.resolve(
      codec.encodeReceive(results, outputs, ctx),
    );

    const item = content[0] as { type: "text"; text: string };
    const parsed = JSON.parse(item.text) as Array<
      { uri: string; accepted: boolean; error?: string }
    >;
    assertEquals("error" in parsed[0], false);
  },
);

Deno.test(
  "encodeReceive: uses JSON.stringify with null, 2 formatting",
  async () => {
    const codec = mcpTextJsonStringify();
    const outputs: Output[] = [["b3nd://p", { v: 1 }]];
    const results: ReceiveResult[] = [{ accepted: true }];
    const ctx = { signal: makeLiveSignal() };

    const content = await Promise.resolve(
      codec.encodeReceive(results, outputs, ctx),
    );

    const item = content[0] as { type: "text"; text: string };
    // The text must be pretty-printed (contain newlines and spaces):
    const expected = JSON.stringify(
      [{ uri: "b3nd://p", accepted: true }],
      null,
      2,
    );
    assertEquals(item.text, expected);
  },
);

// ── Case 4: encodeReadResource → ResourceContent shape ───────────────────

Deno.test(
  "encodeReadResource: single Output → McpResourceContent with mimeType application/json",
  async () => {
    const codec = mcpTextJsonStringify();
    const output: Output = ["b3nd://prog", { key: "value" }];
    const ctx = { signal: makeLiveSignal() };

    const contents = await codec.encodeReadResource(output, "b3nd://prog", ctx);

    assertEquals(contents.length, 1);
    assertEquals(contents[0].type, "resource");
    assertEquals(contents[0].resource.uri, "b3nd://prog");
    assertEquals(contents[0].resource.mimeType, "application/json");
    const text = contents[0].resource.text ?? "";
    const parsed = JSON.parse(text) as { key: string };
    assertEquals(parsed, { key: "value" });
  },
);

Deno.test(
  "encodeReadResource: uses JSON.stringify with null, 2 formatting on the text field",
  async () => {
    const codec = mcpTextJsonStringify();
    const payload = { a: 1, b: [2, 3] };
    const output: Output = ["b3nd://x", payload];
    const ctx = { signal: makeLiveSignal() };

    const contents = await codec.encodeReadResource(output, "b3nd://x", ctx);

    assertEquals(contents[0].resource.text, JSON.stringify(payload, null, 2));
  },
);

Deno.test(
  "encodeReadResource: materializes stream payload before encoding",
  async () => {
    const codec = mcpTextJsonStringify();
    const bytes = new Uint8Array([5, 6, 7]);
    const output: Output = ["b3nd://s", makeStream(bytes)];
    const ctx = { signal: makeLiveSignal() };

    const contents = await codec.encodeReadResource(output, "b3nd://s", ctx);

    assertEquals(contents[0].type, "resource");
    // Stream materialized to Uint8Array; JSON.stringify produces lossy shape:
    const text = contents[0].resource.text ?? "";
    const parsed = JSON.parse(text) as Record<string, number>;
    assertEquals(parsed["0"], 5);
    assertEquals(parsed["1"], 6);
    assertEquals(parsed["2"], 7);
  },
);

// ── Case 5: decodeReadArgs ────────────────────────────────────────────────

Deno.test(
  "decodeReadArgs: extracts urls string[] from { urls: string[] }",
  () => {
    const codec = mcpTextJsonStringify();
    const result = codec.decodeReadArgs({ urls: ["b3nd://a", "b3nd://b"] });
    assertEquals(result, ["b3nd://a", "b3nd://b"]);
  },
);

Deno.test(
  "decodeReadArgs: throws TypeError when urls is missing",
  () => {
    const codec = mcpTextJsonStringify();
    assertThrows(
      () => codec.decodeReadArgs({ other: "field" }),
      TypeError,
    );
  },
);

Deno.test(
  "decodeReadArgs: throws TypeError when urls is not an array",
  () => {
    const codec = mcpTextJsonStringify();
    assertThrows(
      () => codec.decodeReadArgs({ urls: "single-string" }),
      TypeError,
    );
  },
);

Deno.test(
  "decodeReadArgs: throws TypeError when urls contains non-strings",
  () => {
    const codec = mcpTextJsonStringify();
    assertThrows(
      () => codec.decodeReadArgs({ urls: [1, 2, 3] }),
      TypeError,
    );
  },
);

Deno.test(
  "decodeReadArgs: throws TypeError when args is null",
  () => {
    const codec = mcpTextJsonStringify();
    assertThrows(
      () => codec.decodeReadArgs(null),
      TypeError,
    );
  },
);

// ── Case 6: decodeReceiveArgs ─────────────────────────────────────────────

Deno.test(
  "decodeReceiveArgs: extracts messages Output[] from { messages: Output[] }",
  () => {
    const codec = mcpTextJsonStringify();
    const messages: Output[] = [["b3nd://x", { v: 1 }]];
    const result = codec.decodeReceiveArgs({ messages });
    assertEquals(result, messages);
  },
);

Deno.test(
  "decodeReceiveArgs: throws TypeError when messages is missing",
  () => {
    const codec = mcpTextJsonStringify();
    assertThrows(
      () => codec.decodeReceiveArgs({ other: "field" }),
      TypeError,
    );
  },
);

Deno.test(
  "decodeReceiveArgs: throws TypeError when messages is not an array",
  () => {
    const codec = mcpTextJsonStringify();
    assertThrows(
      () => codec.decodeReceiveArgs({ messages: "not-array" }),
      TypeError,
    );
  },
);

Deno.test(
  "decodeReceiveArgs: throws TypeError when args is null",
  () => {
    const codec = mcpTextJsonStringify();
    assertThrows(
      () => codec.decodeReceiveArgs(null),
      TypeError,
    );
  },
);

// ── Case 7: decodeReadResponse round-trip with encodeRead ─────────────────

Deno.test(
  "decodeReadResponse: round-trip with encodeRead — JSON payload survives",
  async () => {
    const codec = mcpTextJsonStringify();
    const outputs: Output[] = [
      ["b3nd://one", { n: 42 }],
      ["b3nd://two", "hello"],
    ];
    const ctx = { signal: makeLiveSignal() };

    const content = await codec.encodeRead(outputs, ctx);
    const decoded = codec.decodeReadResponse(content);

    assertEquals(decoded.length, 2);
    assertEquals(decoded[0][0], "b3nd://one");
    assertEquals(decoded[0][1], { n: 42 });
    assertEquals(decoded[1][0], "b3nd://two");
    assertEquals(decoded[1][1], "hello");
  },
);

Deno.test(
  "decodeReadResponse: returns empty array when content has no text item",
  () => {
    const codec = mcpTextJsonStringify();
    const result = codec.decodeReadResponse([]);
    assertEquals(result, []);
  },
);

// ── Case 8: decodeReceiveResponse round-trip with encodeReceive ───────────

Deno.test(
  "decodeReceiveResponse: round-trip with encodeReceive — accepted + error survive",
  async () => {
    const codec = mcpTextJsonStringify();
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
    const decoded = codec.decodeReceiveResponse(content);

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
    const codec = mcpTextJsonStringify();
    const outputs: Output[] = [["b3nd://z", null]];
    const results: ReceiveResult[] = [{ accepted: true }];
    const ctx = { signal: makeLiveSignal() };

    const content = await Promise.resolve(
      codec.encodeReceive(results, outputs, ctx),
    );
    const decoded = codec.decodeReceiveResponse(content);

    // ReceiveResult has no uri field — the codec strips it on decode:
    assertEquals("uri" in decoded[0], false);
  },
);

// ── Custom scheduler ──────────────────────────────────────────────────────

Deno.test("mcpTextJsonStringify: accepts custom scheduler", async () => {
  let callCount = 0;
  const scheduler = <T>(
    slots: ReadonlyArray<(signal: AbortSignal) => Promise<T>>,
    signal: AbortSignal,
  ): Promise<T[]> => {
    callCount++;
    return Promise.all(slots.map((s) => s(signal)));
  };

  const codec = mcpTextJsonStringify({ scheduler });
  const outputs: Output[] = [["b3nd://a", makeStream(new Uint8Array([99]))]];
  const ctx = { signal: makeLiveSignal() };

  await codec.encodeRead(outputs, ctx);
  assertEquals(callCount, 1);
});
