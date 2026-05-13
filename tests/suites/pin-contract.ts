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
 *   • observe: a write under a subscribed pattern is delivered to the observer
 *   • observe: aborting the signal terminates the iteration cleanly
 *
 * Backend convention is left to the factory — the contract does not
 * assert what a "miss" payload looks like (that's a content/protocol
 * concern per b3nd-core 0.15+).
 *
 * @example
 * ```ts
 * import { pinContract } from "../../suites/pin-contract.ts";
 * import { startHttpServer } from "../../factories/http.ts";
 * import { memoryRig } from "../../rigs/memory.ts";
 * import { HttpClient } from "../../../src/http/client.ts";
 *
 * pinContract("http", async () => {
 *   const server = await startHttpServer(memoryRig());
 *   const client = new HttpClient({ url: server.url });
 *   return { client, cleanup: () => Promise.resolve(server.stop()) };
 * });
 * ```
 */

import { assert, assertEquals } from "@std/assert";
import type { Output, ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wrap a promise with a timeout. Rejects with `Error(label)` if the
 * promise hasn't settled in `ms`. The returned promise also clears its
 * timer when the inner promise resolves so resource sanitizers stay
 * happy.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

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
 * Per-transport sanitizer overrides for the contract suite. Only set
 * these when a known upstream resource quirk produces false-positive
 * leaks in the contract — every override should carry a comment
 * pointing at the upstream cause.
 */
export interface PinContractOptions {
  /**
   * Forward to `Deno.test({ sanitizeOps })`. Defaults to strict (true).
   * Setting `false` should be accompanied by a comment naming the
   * leaked op and the upstream issue.
   */
  sanitizeOps?: boolean;
  /**
   * Forward to `Deno.test({ sanitizeResources })`. Defaults to strict.
   */
  sanitizeResources?: boolean;
}

/**
 * Register the PIN contract as a suite of `Deno.test`s.
 *
 * The `label` prefixes every test name so multiple factories can register
 * the same contract in one process without collision (e.g.
 * `pinContract("grpchttp-json", ...)` and `pinContract("grpchttp-binary", ...)`).
 */
export function pinContract(
  label: string,
  factory: ServerFactory,
  options: PinContractOptions = {},
): void {
  const test = (
    name: string,
    body: (client: ProtocolInterfaceNode) => Promise<void>,
  ): void => {
    Deno.test({
      name: `[${label}] ${name}`,
      sanitizeOps: options.sanitizeOps ?? true,
      sanitizeResources: options.sanitizeResources ?? true,
      fn: async () => {
        const { client, cleanup } = await factory();
        try {
          await body(client);
        } finally {
          await cleanup();
        }
      },
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

  test("observe: write under subscribed pattern is delivered", async (client) => {
    const ac = new AbortController();
    const sub = "mutable://contract-observe/*";
    const target = "mutable://contract-observe/hit";

    const frames: Output<string[]>[] = [];
    const observed = (async () => {
      for await (const frame of client.observe([sub], ac.signal)) {
        frames.push(frame);
        if (frame[1].includes(target)) {
          ac.abort();
          return;
        }
      }
    })();

    // Let the subscription register on the wire before we write.
    // In-process transports settle in <10ms; 100ms is the slack budget.
    await sleep(100);
    await client.receive([[target, { ok: true }]]);

    await withTimeout(observed, 2000, "observe never delivered the write");

    const hit = frames.find(([, uris]) => uris.includes(target));
    assert(hit !== undefined, "expected to see the written uri");
    assertEquals(hit[0], sub);
  });

  test("observe: abort terminates the iteration cleanly", async (client) => {
    const ac = new AbortController();
    const iter = (async () => {
      for await (
        const _frame of client.observe(
          ["mutable://contract-observe-abort/*"],
          ac.signal,
        )
      ) {
        // drain — we never expect to enter this body
      }
    })();
    await sleep(50);
    ac.abort();
    await withTimeout(iter, 2000, "observe did not terminate after abort");
  });
}
