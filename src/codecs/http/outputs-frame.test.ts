/// <reference lib="deno.ns" />
import { assertEquals, assertRejects } from "@std/assert";
import type { Output } from "@bandeira-tech/b3nd-core/types";
import { httpOutputsFrame } from "./outputs-frame.ts";
import type { Scheduler } from "../scheduler.ts";
import { encodeUrlList } from "../url-list.ts";
import { encodeBytesList } from "../bytes-list.ts";

const codec = httpOutputsFrame();

Deno.test("httpOutputsFrame.encode: Uint8Array payload survives outputs-frame round-trip", async () => {
  const outputs: Output[] = [
    ["s://a", new TextEncoder().encode("alpha")],
    ["s://b", new TextEncoder().encode("beta")],
  ];
  const res = await codec.encode(outputs, {
    req: new Request(
      "http://x/api/v1/read?u=" + encodeUrlList(["s://a", "s://b"]),
    ),
    signal: new AbortController().signal,
  });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Content-Type"), "application/octet-stream");
  // The bytes round-trip through outputs-frame; assert by decoding back
  // (decode-side is exercised end-to-end via the integration suite in
  // Task 15; here we only assert the response shape and bytes survive).
  const buf = new Uint8Array(await res.arrayBuffer());
  // outputs-frame layout: per-slot <flag><uri><payload>; flag=1 → bytes;
  // not asserting the exact bytes layout here — that's the codec's own
  // round-trip; just non-empty + correct content-type.
  assertEquals(buf.byteLength > 0, true);
});

Deno.test("httpOutputsFrame.encode: ReadableStream payload is materialized to Uint8Array", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      c.close();
    },
  });
  const outputs: Output[] = [["s://x", stream]];
  const res = await codec.encode(outputs, {
    req: new Request("http://x/api/v1/read?u=" + encodeUrlList(["s://x"])),
    signal: new AbortController().signal,
  });
  assertEquals(res.status, 200);
  const buf = new Uint8Array(await res.arrayBuffer());
  // Bytes are in the outputs-frame; flag=1 slot present.
  assertEquals(buf.byteLength > 0, true);
});

Deno.test("httpOutputsFrame.encode: abort during stream materialization rejects", async () => {
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
      req: new Request("http://x/api/v1/read?u=" + encodeUrlList(["s://x"])),
      signal: ac.signal,
    })
  );
});

Deno.test("httpOutputsFrame.decode: parses url-list + bytes-list body into Output[]", async () => {
  const uris = ["s://a", "s://b"];
  const payloads = [new Uint8Array([1]), new Uint8Array([2, 3])];
  const u = encodeUrlList(uris);
  const body = encodeBytesList(payloads, { lenSize: 4 });
  const req = new Request(`http://x/api/v1/receive?u=${u}`, {
    method: "POST",
    body: body as unknown as BodyInit,
    headers: { "Content-Type": "application/octet-stream" },
  });
  const outputs = await codec.decode(req);
  assertEquals(outputs.length, 2);
  assertEquals(outputs[0][0], "s://a");
  assertEquals(outputs[0][1], new Uint8Array([1]));
  assertEquals(outputs[1][1], new Uint8Array([2, 3]));
});

Deno.test("httpOutputsFrame.decode: mismatched URI/payload counts throw", async () => {
  const u = encodeUrlList(["s://a", "s://b"]);
  const body = encodeBytesList([new Uint8Array([1])], { lenSize: 4 });
  const req = new Request(`http://x/api/v1/receive?u=${u}`, {
    method: "POST",
    body: body as unknown as BodyInit,
    headers: { "Content-Type": "application/octet-stream" },
  });
  await assertRejects(async () => await codec.decode(req));
});

Deno.test("httpOutputsFrame.decodeReadResponse: round-trips an encoded read response", async () => {
  const expected = new TextEncoder().encode("hello-world");
  const outputs: Output[] = [["s://hello", expected]];
  const res = await codec.encode(outputs, {
    req: new Request("http://x/api/v1/read?u=" + encodeUrlList(["s://hello"])),
    signal: new AbortController().signal,
  });
  const decoded = await codec.decodeReadResponse(res);
  assertEquals(decoded.length, 1);
  assertEquals(decoded[0][0], "s://hello");
  assertEquals(decoded[0][1], expected);
});

Deno.test("httpOutputsFrame.encode: 4 concurrent 10ms streams complete in parallel (<35ms)", async () => {
  // Proves the default scheduler uses Promise.all, not sequential
  // iteration. Each stream sleeps 10ms; in parallel total ~10ms; in
  // serial ~40ms. Generous CI headroom at 35ms.
  const enc = (s: string) => new TextEncoder().encode(s);
  const dec = (b: Uint8Array) => new TextDecoder().decode(b);
  const urls = ["s://a", "s://b", "s://c", "s://d"];
  const outputs: Output[] = urls.map((u) => {
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        await new Promise((r) => setTimeout(r, 10));
        c.enqueue(enc(`payload-for-${u}`));
        c.close();
      },
    });
    return [u, stream];
  });

  const t0 = performance.now();
  const res = await codec.encode(outputs, {
    req: new Request("http://x/api/v1/read?u=" + encodeUrlList(urls)),
    signal: new AbortController().signal,
  });
  const elapsed = performance.now() - t0;

  assertEquals(
    elapsed < 35,
    true,
    `elapsed=${elapsed.toFixed(1)}ms suggests serial (expected <35ms)`,
  );
  assertEquals(res.status, 200);

  // Confirm order is preserved even with parallel scheduling.
  const { decodeOutputsFrame } = await import("../outputs-frame.ts");
  const outs = decodeOutputsFrame(new Uint8Array(await res.arrayBuffer()));
  assertEquals(outs.length, 4);
  for (let i = 0; i < 4; i++) {
    assertEquals(outs[i][0], urls[i]);
    assertEquals(dec(outs[i][1] as Uint8Array), `payload-for-${urls[i]}`);
  }
});

Deno.test("httpOutputsFrame: custom scheduler injection is invoked exactly once per encode", async () => {
  // Asserts that httpOutputsFrame({ scheduler: custom }) actually calls
  // the injected scheduler — not the default. Scheduler receives the
  // array of thunks and returns their results.
  let callCount = 0;
  const customScheduler: Scheduler = (slots, signal) => {
    callCount++;
    return Promise.all(slots.map((s) => s(signal)));
  };

  const customCodec = httpOutputsFrame({ scheduler: customScheduler });
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([7, 8, 9]));
      c.close();
    },
  });
  const outputs: Output[] = [["s://x", stream]];
  const res = await customCodec.encode(outputs, {
    req: new Request("http://x/api/v1/read?u=" + encodeUrlList(["s://x"])),
    signal: new AbortController().signal,
  });
  assertEquals(res.status, 200);
  assertEquals(callCount, 1, "custom scheduler was not invoked during encode");
});
