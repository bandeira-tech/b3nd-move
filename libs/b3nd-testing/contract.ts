/**
 * @module
 * PIN contract — a fixed set of `Deno.test`s exercising the framework
 * invariants of `ProtocolInterfaceNode` over the network boundary.
 *
 * Each transport supplies a `ServerFactory` that boots a rig + transport
 * in-process on an ephemeral port and returns a fully-typed PIN client
 * pointing at it, plus a cleanup hook. The contract calls only PIN
 * methods — anything transport-specific belongs in the transport's own
 * test file.
 *
 * Framework-level invariants asserted here:
 *   • status() returns "healthy" on a fresh rig
 *   • receive: one ReceiveResult per input message, in input order
 *   • read:    one Output per input url, with `output[0] === inputUrl`
 *   • round-trip: payload written via receive round-trips byte-equal via read
 *   • batch order preserved across mixed hits
 *
 * Backend convention is left to the factory — the contract does not
 * assert what a "miss" payload looks like (that's a content/protocol
 * concern per b3nd-core 0.15+).
 *
 * @example
 * ```ts
 * import { pinContract } from "@bandeira-tech/b3nd-servers/testing";
 * import { httpInProcess } from "@bandeira-tech/b3nd-servers/testing/factories/http";
 *
 * pinContract("http-in-process", httpInProcess);
 * ```
 */

import { assertEquals } from "@std/assert";
import type { ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core";

/**
 * Factory for an in-process server + matching PIN client.
 *
 * Implementations boot a rig + transport on an ephemeral port, return a
 * connected client pointing at it, and a `cleanup` that tears down the
 * server. Cleanup runs in a `finally` after every contract test — make
 * it idempotent.
 */
export type ServerFactory = () => Promise<{
  client: ProtocolInterfaceNode;
  cleanup: () => Promise<void> | void;
}>;

/**
 * Register the PIN contract as a suite of `Deno.test`s.
 *
 * The `label` prefixes every test name so multiple factories can register
 * the same contract in one process without collision (e.g.
 * `pinContract("grpchttp-json", ...)` and `pinContract("grpchttp-binary", ...)`).
 */
export function pinContract(label: string, factory: ServerFactory): void {
  const test = (
    name: string,
    body: (client: ProtocolInterfaceNode) => Promise<void>,
  ): void => {
    Deno.test(`[${label}] ${name}`, async () => {
      const { client, cleanup } = await factory();
      try {
        await body(client);
      } finally {
        await cleanup();
      }
    });
  };

  test("status() returns healthy", async (client) => {
    const status = await client.status();
    assertEquals(status.status, "healthy");
  });

  test("receive: one ReceiveResult per input, in order", async (client) => {
    const results = await client.receive([
      ["mutable://contract/a", { i: 0 }],
      ["mutable://contract/b", { i: 1 }],
      ["mutable://contract/c", { i: 2 }],
    ]);
    assertEquals(results.length, 3);
    assertEquals(results.map((r) => r.accepted), [true, true, true]);
  });

  test("read: one Output per input, with uri echoed", async (client) => {
    await client.receive([["mutable://contract/echo", { hello: "world" }]]);
    const outputs = await client.read([
      "mutable://contract/echo",
      "mutable://contract/missing",
    ]);
    assertEquals(outputs.length, 2);
    assertEquals(outputs[0][0], "mutable://contract/echo");
    assertEquals(outputs[1][0], "mutable://contract/missing");
  });

  test("round-trip: payload survives receive → read", async (client) => {
    const payload = {
      num: 42,
      str: "hi",
      arr: [1, 2, 3],
      nested: { ok: true },
    };
    await client.receive([["mutable://contract/roundtrip", payload]]);
    const [[uri, got]] = await client.read(["mutable://contract/roundtrip"]);
    assertEquals(uri, "mutable://contract/roundtrip");
    assertEquals(got, payload);
  });

  test("batch read: order preserved across mixed hits and misses", async (client) => {
    await client.receive([
      ["mutable://contract/x", "X"],
      ["mutable://contract/z", "Z"],
    ]);
    const outputs = await client.read([
      "mutable://contract/x",
      "mutable://contract/missing-1",
      "mutable://contract/z",
      "mutable://contract/missing-2",
    ]);
    assertEquals(outputs.length, 4);
    assertEquals(outputs.map(([u]) => u), [
      "mutable://contract/x",
      "mutable://contract/missing-1",
      "mutable://contract/z",
      "mutable://contract/missing-2",
    ]);
    assertEquals(outputs[0][1], "X");
    assertEquals(outputs[2][1], "Z");
  });
}
