/**
 * Shared Test Suite for ProtocolInterfaceNode
 *
 * Tests that any implementation of ProtocolInterfaceNode behaves
 * correctly as **mechanical storage**.
 *
 * Message primitive: [uri, payload] where:
 * - uri: string — identity/address
 * - payload: protocol-defined; for envelope-shaped payloads
 *   `{ inputs: string[], outputs: Output[] }`.
 *
 * receive() takes Message[] (batch, each independently processed).
 * read() returns record with { data }.
 *
 * Clients are mechanical: delete inputs, write outputs. No validation,
 * no conservation checks — the rig handles classification via programs.
 * Conservation and program logic are **rig-level** concerns. UTXO-style
 * conserved quantities live inside the payload at protocol-defined keys
 * (e.g. `payload.values.fire`).
 *
 * Each client test file imports and runs this suite with factory functions
 * that create fresh client instances for each test.
 */

/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import type { ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core/types";

// ── Helpers ──────────────────────────────────────────────────────────

let _seq = 0;

/** Build a Message wrapping outputs into an envelope. No inputs. */
function msg(
  outputs: [string, unknown][],
  inputs: string[] = [],
): [
  string,
  { inputs: string[]; outputs: [string, unknown][] },
] {
  return [`envelope://test/${++_seq}`, { inputs, outputs }];
}

/**
 * Test client factory functions for different scenarios
 */
export interface TestClientFactories {
  /** Factory for working client (happy path tests) */
  happy: () => ProtocolInterfaceNode | Promise<ProtocolInterfaceNode>;

  /** Factory for client that simulates connection/network errors */
  connectionError?: () =>
    | ProtocolInterfaceNode
    | Promise<ProtocolInterfaceNode>;

  /** Factory for client that simulates validation errors */
  validationError?: () =>
    | ProtocolInterfaceNode
    | Promise<ProtocolInterfaceNode>;
}

/**
 * Run the complete shared test suite against provided client factories
 */
export function runSharedSuite(
  suiteName: string,
  factories: TestClientFactories,
) {
  // Disable sanitizers — clients like Postgres open TCP connections that
  // outlive individual tests (no cleanup() in ProtocolInterfaceNode).
  const noSanitize = { sanitizeOps: false, sanitizeResources: false };

  // ── Basic receive/read ─────────────────────────────────────────────

  Deno.test({
    name: `${suiteName} - receive message and read`,
    ...noSanitize,
    fn: async () => {
      const client = await Promise.resolve(factories.happy());

      const results = await client.receive([
        msg([["store://users/alice/profile", {
          name: "Alice",
          email: "alice@example.com",
        }]]),
      ]);

      assertEquals(results[0].accepted, true);

      const readResults = await client.read(["store://users/alice/profile"]);

      assertEquals(readResults.length, 1);
      assertEquals(readResults[0]?.[1], {
        name: "Alice",
        email: "alice@example.com",
      });
    },
  });

  Deno.test({
    name: `${suiteName} - read non-existent yields nullish payload`,
    ...noSanitize,
    fn: async () => {
      const client = await Promise.resolve(factories.happy());

      const readResults = await client.read(["store://users/nobody/profile"]);

      // 1:1 with input: slot present. The framework doesn't dictate
      // miss representation — accept undefined (in-process) or null
      // (after JSON round-trip).
      assertEquals(readResults.length, 1);
      assertEquals(readResults[0]?.[1] == null, true);
    },
  });

  // ── Scalar data types ──────────────────────────────────────────────

  Deno.test({
    name: `${suiteName} - receive and read string data`,
    ...noSanitize,
    fn: async () => {
      const client = await Promise.resolve(factories.happy());

      const results = await client.receive([
        msg([["store://users/scalar-string/data", "hello world"]]),
      ]);
      assertEquals(results[0].accepted, true);

      const readResults = await client.read([
        "store://users/scalar-string/data",
      ]);
      assertEquals(readResults.length, 1);
      assertEquals(readResults[0]?.[1], "hello world");
    },
  });

  Deno.test({
    name: `${suiteName} - receive and read number data`,
    ...noSanitize,
    fn: async () => {
      const client = await Promise.resolve(factories.happy());

      const results = await client.receive([
        msg([["store://users/scalar-number/data", 42]]),
      ]);
      assertEquals(results[0].accepted, true);

      const readResults = await client.read([
        "store://users/scalar-number/data",
      ]);
      assertEquals(readResults.length, 1);
      assertEquals(readResults[0]?.[1], 42);
    },
  });

  Deno.test({
    name: `${suiteName} - receive and read boolean data`,
    ...noSanitize,
    fn: async () => {
      const client = await Promise.resolve(factories.happy());

      const results = await client.receive([
        msg([["store://users/scalar-bool/data", true]]),
      ]);
      assertEquals(results[0].accepted, true);

      const readResults = await client.read(["store://users/scalar-bool/data"]);
      assertEquals(readResults.length, 1);
      assertEquals(readResults[0]?.[1], true);
    },
  });

  Deno.test({
    name: `${suiteName} - receive and read null data`,
    ...noSanitize,
    fn: async () => {
      const client = await Promise.resolve(factories.happy());

      const results = await client.receive([
        msg([["store://users/scalar-null/data", null]]),
      ]);
      assertEquals(results[0].accepted, true);

      const readResults = await client.read(["store://users/scalar-null/data"]);
      assertEquals(readResults.length, 1);
      assertEquals(readResults[0]?.[1], null);
    },
  });

  Deno.test({
    name: `${suiteName} - receive and read empty string data`,
    ...noSanitize,
    fn: async () => {
      const client = await Promise.resolve(factories.happy());

      const results = await client.receive([
        msg([["store://users/scalar-empty/data", ""]]),
      ]);
      assertEquals(results[0].accepted, true);

      const readResults = await client.read([
        "store://users/scalar-empty/data",
      ]);
      assertEquals(readResults.length, 1);
      assertEquals(readResults[0]?.[1], "");
    },
  });

  Deno.test({
    name: `${suiteName} - receive and read zero data`,
    ...noSanitize,
    fn: async () => {
      const client = await Promise.resolve(factories.happy());

      const results = await client.receive([
        msg([["store://users/scalar-zero/data", 0]]),
      ]);
      assertEquals(results[0].accepted, true);

      const readResults = await client.read(["store://users/scalar-zero/data"]);
      assertEquals(readResults.length, 1);
      assertEquals(readResults[0]?.[1], 0);
    },
  });

  // ── Conserved quantities live inside the payload ───────────────────
  // Per RFC 001, the wire primitive has no `values` slot. UTXO-style
  // protocols put conserved quantities at `payload.values`.

  Deno.test({
    name: `${suiteName} - receive and read output with single asset value`,
    ...noSanitize,
    fn: async () => {
      const client = await Promise.resolve(factories.happy());

      const results = await client.receive([
        msg([["store://balance/alice/utxo-1", { values: { fire: 100 } }]]),
      ]);
      assertEquals(results[0].accepted, true);

      const readResults = await client.read(["store://balance/alice/utxo-1"]);
      assertEquals(readResults.length, 1);
      assertEquals(readResults[0]?.[1], { values: { fire: 100 } });
    },
  });

  Deno.test({
    name: `${suiteName} - receive and read output with multi-asset value`,
    ...noSanitize,
    fn: async () => {
      const client = await Promise.resolve(factories.happy());

      const results = await client.receive([
        msg([["store://balance/alice/utxo-2", {
          values: { fire: 50, usd: 200 },
          memo: "deposit",
        }]]),
      ]);
      assertEquals(results[0].accepted, true);

      const readResults = await client.read(["store://balance/alice/utxo-2"]);
      assertEquals(readResults.length, 1);
      assertEquals(readResults[0]?.[1], {
        values: { fire: 50, usd: 200 },
        memo: "deposit",
      });
    },
  });

  // ── Batch receive ──────────────────────────────────────────────────

  Deno.test({
    name: `${suiteName} - receive batch of independent messages`,
    ...noSanitize,
    fn: async () => {
      const client = await Promise.resolve(factories.happy());

      const results = await client.receive([
        msg([["store://users/batch-a/profile", { name: "Alice" }]]),
        msg([["store://users/batch-b/profile", { name: "Bob" }]]),
        msg([["store://users/batch-c/profile", { name: "Charlie" }]]),
      ]);

      assertEquals(results.length, 3);
      assertEquals(results[0].accepted, true);
      assertEquals(results[1].accepted, true);
      assertEquals(results[2].accepted, true);

      // All outputs readable
      const readResults = await client.read([
        "store://users/batch-a/profile",
        "store://users/batch-b/profile",
        "store://users/batch-c/profile",
      ]);

      assertEquals(readResults.length, 3);
      assertEquals(readResults[0]?.[1], { name: "Alice" });
      assertEquals(readResults[1]?.[1], { name: "Bob" });
      assertEquals(readResults[2]?.[1], { name: "Charlie" });
    },
  });

  // ── Read: multiple URIs, partial failures, trailing slash ──────────

  Deno.test({
    name: `${suiteName} - read multiple URIs`,
    ...noSanitize,
    fn: async () => {
      const client = await Promise.resolve(factories.happy());

      await client.receive([
        msg([["store://users/multi-a/profile", { v: 1 }]]),
        msg([["store://users/multi-b/profile", { v: 2 }]]),
        msg([["store://users/multi-c/profile", { v: 3 }]]),
      ]);

      const results = await client.read([
        "store://users/multi-a/profile",
        "store://users/multi-b/profile",
        "store://users/multi-c/profile",
      ]);

      assertEquals(results.length, 3);
      assertEquals(results[0]?.[1], { v: 1 });
      assertEquals(results[1]?.[1], { v: 2 });
      assertEquals(results[2]?.[1], { v: 3 });
    },
  });

  Deno.test({
    name: `${suiteName} - read with partial failures`,
    ...noSanitize,
    fn: async () => {
      const client = await Promise.resolve(factories.happy());

      await client.receive([
        msg([["store://users/partial-a/profile", { ok: true }]]),
      ]);

      const results = await client.read([
        "store://users/partial-a/profile",
        "store://users/partial-missing/profile",
      ]);

      // 1:1 with input: 1 hit + 1 miss = 2 slots, miss has nullish payload.
      assertEquals(results.length, 2);
      assertEquals(results[0]?.[0], "store://users/partial-a/profile");
      assertEquals(results[0]?.[1], { ok: true });
      assertEquals(results[1]?.[1] == null, true);
    },
  });

  Deno.test({
    name: `${suiteName} - read with trailing slash lists children`,
    ...noSanitize,
    fn: async () => {
      const client = await Promise.resolve(factories.happy());

      const prefix = `store://users/list-test-${Date.now()}`;
      await client.receive([
        msg([[`${prefix}/alice/profile`, { name: "Alice" }]]),
        msg([[`${prefix}/bob/profile`, { name: "Bob" }]]),
        msg([[`${prefix}/charlie/profile`, { name: "Charlie" }]]),
      ]);

      const results = await client.read([`${prefix}/`]);

      // 1:1: one outer slot. Payload is Output[] of entries under prefix.
      assertEquals(results.length, 1);
      const entries = results[0]?.[1] as Array<[string, unknown]>;
      assertEquals(
        entries.length >= 3,
        true,
        `Should return at least 3 items, got ${entries.length}`,
      );
    },
  });

  Deno.test({
    name: `${suiteName} - status returns healthy`,
    ...noSanitize,
    fn: async () => {
      const client = await Promise.resolve(factories.happy());

      const status = await client.status();

      assertEquals(typeof status.status, "string");
      assertEquals(
        ["healthy", "unhealthy"].includes(status.status),
        true,
      );
    },
  });

  // Wire-level content preservation (undefined, binary, etc.) is not a
  // framework or transport contract. Callers opt in to content codecs
  // (e.g. `@bandeira-tech/b3nd-canon/binary`) at their own layer if
  // they need specific guarantees. No shared-suite content tests.

  // ── Overwrite ───────────────────────────────────────────────────────

  Deno.test({
    name: `${suiteName} - receive overwrites existing data at same URI`,
    ...noSanitize,
    fn: async () => {
      const client = await Promise.resolve(factories.happy());

      await client.receive([
        msg([["store://users/overwrite/profile", {
          name: "Alice",
          version: 1,
        }]]),
      ]);

      // Write again to the same URI — second write wins
      await client.receive([
        msg([["store://users/overwrite/profile", {
          name: "Alice Updated",
          version: 2,
        }]]),
      ]);

      const readResults = await client.read([
        "store://users/overwrite/profile",
      ]);
      assertEquals(readResults.length, 1);
      assertEquals(readResults[0]?.[1], {
        name: "Alice Updated",
        version: 2,
      });
    },
  });

  Deno.test({
    name: `${suiteName} - overwrite preserves new payload`,
    ...noSanitize,
    fn: async () => {
      const client = await Promise.resolve(factories.happy());

      await client.receive([
        msg([["store://balance/overwrite/utxo", { values: { fire: 100 } }]]),
      ]);

      await client.receive([
        msg([["store://balance/overwrite/utxo", {
          values: { fire: 75, usd: 25 },
          memo: "updated",
        }]]),
      ]);

      const readResults = await client.read(["store://balance/overwrite/utxo"]);
      assertEquals(readResults[0]?.[1], {
        values: { fire: 75, usd: 25 },
        memo: "updated",
      });
    },
  });

  // NOTE: Envelope decomposition (input consumption, output fan-out) is a
  // protocol concern handled by `messageDataProgram` + `messageDataHandler`
  // installed on a Rig — not a generic ProtocolInterfaceNode behavior. The
  // shared suite stays focused on the wire-level contract.

  // ── Error handling ─────────────────────────────────────────────────

  if (factories.validationError) {
    Deno.test({
      name: `${suiteName} - validation error on receive`,
      ...noSanitize,
      fn: async () => {
        const client = await Promise.resolve(factories.validationError!());

        const results = await client.receive([
          msg([["store://users/invalid/data", { invalid: true }]]),
        ]);

        assertEquals(results[0].accepted, false);
      },
    });
  }

  if (factories.connectionError) {
    Deno.test({
      name: `${suiteName} - connection error handling`,
      ...noSanitize,
      fn: async () => {
        const client = await Promise.resolve(factories.connectionError!());

        const results = await client.receive([
          msg([["store://users/test/data", { value: 123 }]]),
        ]);

        assertEquals(results[0].accepted, false);

        // Transport errors throw under option-A (vs. per-url failure
        // results in the previous design).
        let threw = false;
        try {
          await client.read(["store://users/test/data"]);
        } catch {
          threw = true;
        }
        assertEquals(threw, true, "read should throw on transport failure");
      },
    });
  }
}
