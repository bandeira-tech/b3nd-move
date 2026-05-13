/**
 * Browser-side suite for b3nd-move ProtocolInterfaceNode clients.
 *
 * Asserts the move layer (encode → transport → decode) carries
 * the PIN API faithfully across a real browser fetch/WebSocket
 * boundary. Every test exercises BATCH on both sides (multi-input
 * requests, multi-output responses), since that's where encoding
 * bugs hide.
 *
 * The suite does NOT validate storage semantics — there is no rig
 * and no store. The transport stubs in `tests/runners/stubs/` are
 * deterministic, content-addressed echoers:
 *
 *   receive([uri, payload]):
 *     - uri contains "/__reject__/" → { accepted: false, error: "rejected by stub" }
 *     - otherwise                   → { accepted: true,  ref: uri }
 *
 *   read(urls):
 *     - url contains "/__miss__/"   → [url, null]
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
  Message,
  Output,
  ProtocolInterfaceNode,
} from "@bandeira-tech/b3nd-core/types";

export interface MoveSuiteConfig {
  /** Factory that returns a fresh client for each test. */
  client: () => ProtocolInterfaceNode | Promise<ProtocolInterfaceNode>;
  /** Set to false if the transport doesn't implement observe. */
  supportsObserve?: boolean;
}

const noSanitize = { sanitizeOps: false, sanitizeResources: false };

export function runMoveSuite(suiteName: string, config: MoveSuiteConfig) {
  const supportsObserve = config.supportsObserve !== false;

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

  t("receive: 5-message batch, all accepted, preserves order", async () => {
    const client = await Promise.resolve(config.client());
    const msgs: Message[] = [
      ["mutable://t/recv/a", { v: 1 }],
      ["mutable://t/recv/b", { v: 2 }],
      ["mutable://t/recv/c", { v: 3 }],
      ["mutable://t/recv/d", { v: 4 }],
      ["mutable://t/recv/e", { v: 5 }],
    ];
    const results = await client.receive(msgs);
    assertEquals(results.length, msgs.length);
    for (let i = 0; i < msgs.length; i++) {
      assertEquals(results[i].accepted, true);
    }
  });

  t(
    "receive: 5-message batch with mixed accept/reject, slot ordering",
    async () => {
      const client = await Promise.resolve(config.client());
      const msgs: Message[] = [
        ["mutable://t/mixed/a", { v: 1 }],
        ["mutable://t/mixed/__reject__/b", { v: 2 }],
        ["mutable://t/mixed/c", { v: 3 }],
        ["mutable://t/mixed/__reject__/d", { v: 4 }],
        ["mutable://t/mixed/e", { v: 5 }],
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
        const seen: Output<string[]>[] = [];
        const expectedTotal = patterns.length * 3;
        const consumer = (async () => {
          for await (const frame of client.observe(patterns, ac.signal)) {
            seen.push(frame);
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
        // Every subscribed pattern must have yielded at least one frame
        // (proves multi-input subscriptions); total frame count proves
        // multi-output emission.
        const byPattern = new Map<string, string[][]>();
        for (const [p, uris] of seen) {
          const arr = byPattern.get(p) ?? [];
          arr.push(uris);
          byPattern.set(p, arr);
        }
        assertEquals(byPattern.size, patterns.length);
        assertEquals(seen.length >= expectedTotal, true);
      },
    );
  }
}
