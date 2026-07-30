/**
 * Browser-side suite for b3nd-move ProtocolInterfaceNode clients.
 *
 * Asserts the move layer (encode → transport → decode) carries
 * the PIN API faithfully across a real browser fetch/WebSocket
 * boundary. Every test exercises BATCH on both sides (multi-input
 * requests, multi-output responses), since that's where encoding
 * bugs hide.
 *
 * The suite does NOT validate storage semantics — it runs against the
 * `stubRig` from `tests/rigs/stub.ts`, whose backing PIN echoes
 * deterministically per these content-addressed rules:
 *
 *   receive([uri, payload]):
 *     - uri contains "/__reject__/" → { accepted: false, error: "rejected by stub" }
 *     - otherwise                   → { accepted: true,  ref: uri }
 *
 *   read(urls):
 *     - url contains "/__miss__/"   → [url, null]
 *     - url contains "/__absent__/" → [url, undefined]
 *     - otherwise                   → [url, { echo: url }]
 *
 *   observe(pattern):
 *     - emits THREE events per subscribed pattern with synthesized uris
 *       `${pattern}/0`, `${pattern}/1`, `${pattern}/2`, then ends the
 *       stream. Transports may surface them as one frame per event
 *       (HTTP/SSE) or one frame per package (WS).
 *
 *   status():
 *     - { status: "healthy", fns: ["receive","read","observe","status"],
 *         message: "stub" }
 *
 * Each transport's harness imports this and runs:
 *
 *     runMoveSuite("HttpClient (browser)", {
 *       client: () => new HttpClient({ url: serverUrl() }),
 *     });
 */

/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import type {
  Output,
  ProtocolInterfaceNode,
} from "@bandeira-tech/b3nd-core/types";

export interface MoveSuiteConfig {
  /** Factory that returns a fresh client for each test. */
  client: () => ProtocolInterfaceNode | Promise<ProtocolInterfaceNode>;
  /** Set to false if the transport doesn't implement observe. */
  supportsObserve?: boolean;
  /**
   * Encode a JS-value payload into whatever this transport's
   * `receive` wire accepts. HTTP uses opaque bytes — pass
   * `(v) => new TextEncoder().encode(JSON.stringify(v))`. WS and
   * gRPC still serialize JS values inside their own envelopes —
   * leave undefined (identity). The stub rig ignores payload
   * content, so the encoding is purely for what the wire requires.
   */
  payload?: (value: unknown) => unknown;
}

const noSanitize = { sanitizeOps: false, sanitizeResources: false };

export function runMoveSuite(suiteName: string, config: MoveSuiteConfig) {
  const supportsObserve = config.supportsObserve !== false;
  const encodePayload = config.payload ?? ((v: unknown) => v);

  const t = (name: string, fn: () => void | Promise<void>) =>
    Deno.test({ name: `${suiteName} — ${name}`, ...noSanitize, fn });

  // ── status ──────────────────────────────────────────────────────

  t("status: client decodes healthy shape", async () => {
    const client = await Promise.resolve(config.client());
    const status = await client.status();
    assertEquals(status.status, "healthy");
    // fns advertisement round-trips
    assertEquals(Array.isArray(status.fns), true);
    assertEquals((status.fns ?? []).includes("receive"), true);
    assertEquals((status.fns ?? []).includes("read"), true);
  });

  // ── receive: batch in, batch out ────────────────────────────────

  t("receive: 5-output batch, all accepted, preserves order", async () => {
    const client = await Promise.resolve(config.client());
    const msgs: Output[] = [
      ["mutable://t/recv/a", encodePayload({ v: 1 })],
      ["mutable://t/recv/b", encodePayload({ v: 2 })],
      ["mutable://t/recv/c", encodePayload({ v: 3 })],
      ["mutable://t/recv/d", encodePayload({ v: 4 })],
      ["mutable://t/recv/e", encodePayload({ v: 5 })],
    ];
    const results = await client.receive(msgs);
    assertEquals(results.length, msgs.length);
    for (let i = 0; i < msgs.length; i++) {
      assertEquals(results[i].accepted, true);
    }
  });

  t(
    "receive: 5-output batch with mixed accept/reject, slot ordering",
    async () => {
      const client = await Promise.resolve(config.client());
      const msgs: Output[] = [
        ["mutable://t/mixed/a", encodePayload({ v: 1 })],
        ["mutable://t/mixed/__reject__/b", encodePayload({ v: 2 })],
        ["mutable://t/mixed/c", encodePayload({ v: 3 })],
        ["mutable://t/mixed/__reject__/d", encodePayload({ v: 4 })],
        ["mutable://t/mixed/e", encodePayload({ v: 5 })],
      ];
      const results = await client.receive(msgs);
      assertEquals(results.length, msgs.length);
      assertEquals(results[0].accepted, true);
      assertEquals(results[1].accepted, false);
      assertEquals(results[2].accepted, true);
      assertEquals(results[3].accepted, false);
      assertEquals(results[4].accepted, true);
    },
  );

  // ── read: batch in, batch out ───────────────────────────────────

  t("read: 5-url batch, all hits, payload echo + order", async () => {
    const client = await Promise.resolve(config.client());
    const urls = [
      "mutable://t/read/a",
      "mutable://t/read/b",
      "mutable://t/read/c",
      "mutable://t/read/d",
      "mutable://t/read/e",
    ];
    const results = await client.read(urls);
    assertEquals(results.length, urls.length);
    for (let i = 0; i < urls.length; i++) {
      const [outUri, payload] = results[i] as Output;
      assertEquals(outUri, urls[i]);
      assertEquals(payload, { echo: urls[i] });
    }
  });

  t("read: 5-url batch with mixed hit/miss, slot ordering", async () => {
    const client = await Promise.resolve(config.client());
    const urls = [
      "mutable://t/mixed/a",
      "mutable://t/mixed/__miss__/b",
      "mutable://t/mixed/c",
      "mutable://t/mixed/__miss__/d",
      "mutable://t/mixed/e",
    ];
    const results = await client.read(urls);
    assertEquals(results.length, urls.length);
    // Hits decode payload, misses surface nullish — slot positions kept.
    assertEquals((results[0] as Output)[1], { echo: urls[0] });
    assertEquals((results[1] as Output)[1] == null, true);
    assertEquals((results[2] as Output)[1], { echo: urls[2] });
    assertEquals((results[3] as Output)[1] == null, true);
    assertEquals((results[4] as Output)[1], { echo: urls[4] });
  });

  t(
    "read: an absent upstream payload arrives as the null sentinel",
    async () => {
      const client = await Promise.resolve(config.client());
      // The stub answers `/__absent__/` with `undefined` — the shape a backing
      // PIN naturally produces for a URI it doesn't hold. Every codec must
      // normalize it to `null`, or the transports disagree about a miss.
      const urls = ["mutable://t/absent/__absent__/a", "mutable://t/absent/b"];
      const results = await client.read(urls);
      assertEquals(results.length, 2);
      assertEquals((results[0] as Output)[1], null);
      assertEquals((results[1] as Output)[1], { echo: urls[1] });
    },
  );

  t(
    "read: upstream ReadableStream → wire delivers bytes (round-trip through codec)",
    async () => {
      const client = await Promise.resolve(config.client());
      const url = "mutable://t/__stream__/x";
      const results = await client.read([url]);
      assertEquals(results.length, 1);
      const [outUri, payload] = results[0] as Output;
      assertEquals(outUri, url);
      // The wire MUST deliver a concrete shape — not a ReadableStream.
      assertEquals(
        payload !== null && typeof payload === "object" &&
          typeof (payload as { getReader?: unknown }).getReader === "function",
        false,
        "wire delivered a ReadableStream — encoder failed to materialize",
      );
      // Each transport's codec.decodeReadResponse already runs on the
      // client side and reverses the wire's shape. For byte-faithful
      // codecs (httpOutputsFrame, wsJsonEnvelopeBase64, grpcProto binary,
      // mcpResourcePerSlot), the payload equals the upstream bytes.
      // For lossy codecs (wsJsonEnvelope, grpcProto JSON,
      // mcpTextJsonStringify), the payload is the documented coercion.
      // The assertion above ("not a stream") is the universal property;
      // codec-specific shape tests live in each codec's *.test.ts.
    },
  );

  // ── observe: batch subscriptions, batch frames ──────────────────

  if (supportsObserve) {
    t(
      "observe: 3 patterns × 3 emitted events = batch on both sides",
      async () => {
        const client = await Promise.resolve(config.client());
        const patterns = [
          "mutable://t/obs/one",
          "mutable://t/obs/two",
          "mutable://t/obs/three",
        ];
        const ac = new AbortController();
        const seen: (readonly string[])[] = [];
        const expectedTotal = patterns.length * 3;
        const consumer = (async () => {
          for await (const batch of client.observe(patterns, ac.signal)) {
            seen.push(batch);
            if (seen.length >= expectedTotal) ac.abort();
          }
        })();
        // Belt-and-braces timeout so a broken transport doesn't hang
        // the browser run.
        const timeout = new Promise<void>((resolve) => {
          setTimeout(() => {
            ac.abort();
            resolve();
          }, 5000);
        });
        await Promise.race([consumer, timeout]);
        // Every subscribed pattern must have produced at least one uri
        // (proves multi-input subscriptions); total batch count proves
        // multi-output emission.
        const firedUris = seen.flatMap((b) => [...b]);
        const patternsHit = new Set(
          patterns.filter((p) => firedUris.some((u) => u.startsWith(`${p}/`))),
        );
        assertEquals(patternsHit.size, patterns.length);
        assertEquals(seen.length >= expectedTotal, true);
      },
    );
  }
}
