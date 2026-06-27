/// <reference lib="deno.ns" />
/**
 * @module
 * Edge-case battery for `readAction` / `materializeStreams`.
 *
 * Every documented sharp edge in the PR #50 review verdict has a named
 * test here. If a future contributor regresses the materialize seam,
 * one of these fails loudly:
 *
 * - **empty-stream**: zero chunks before close → `Uint8Array(0)`, NOT
 *   `null`. Distinguishes "missing" from "empty" — both legal upstream
 *   shapes, both must round-trip distinctly.
 * - **mid-stream-error**: a stream that throws after one chunk → the
 *   action's `Promise.all` rejects with the inner error. Documents the
 *   sibling-drain concern: today other slots may have already started
 *   materializing and run to completion in parallel.
 * - **ReadableStream<string> duck-type**: `getReader`-duck-type accepts
 *   string streams too; today's `materializeStreams` will reject when
 *   `WritableStream<Uint8Array>` receives a string. Pins the (lossy)
 *   gap — see verdict's "duck-type accepts ReadableStream<string>" item.
 * - **cross-realm-like ReadableStream**: a pseudo-stream constructed
 *   off `ReadableStream.prototype` still matches via duck-type, locking
 *   the contract that the materialize doesn't `instanceof`.
 *
 * The abort + never-closing case is covered by dev-impl's M4 unit
 * tests in `./standard.test.ts` (`readAction rejects when signal aborts
 * mid-stream (no leak)`) and by the per-transport smoke tests in
 * `../grpc/http/read.test.ts` and `../ws/read.test.ts`.
 *
 * Background:
 * - PR #50 review (`immutable://open/cc-chat/20260627141221-pr50-review/`)
 * - PR #50 follow-ups room (`immutable://open/cc-chat/20260627143222-pr50-followups/`)
 * - round-3 payload contract (`immutable://open/cc-chat/20260624224342-payload-contract/`)
 */

import { assertEquals, assertRejects } from "@std/assert";
import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { readAction } from "./standard.ts";

function rigOf(node: ProtocolInterfaceNode): Rig {
  const c = connection(node, ["s://**"]);
  return new Rig({ routes: { receive: [c], read: [c], observe: [c] } });
}

const sig = () => new AbortController().signal;

// ── empty-stream ───────────────────────────────────────────────────────

Deno.test(
  "readAction: empty stream materializes to Uint8Array(0), distinct from null",
  async () => {
    class EmptyStreamNode implements ProtocolInterfaceNode {
      read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
        return Promise.resolve(urls.map((u): Output<T> => {
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              c.close(); // zero chunks
            },
          });
          return [u, stream] as unknown as Output<T>;
        }));
      }
      receive(): Promise<ReceiveResult[]> {
        return Promise.resolve([]);
      }
      async *observe(): AsyncIterable<readonly string[]> {
        yield [] as readonly string[];
      }
      status(): Promise<StatusResult> {
        return Promise.resolve({ status: "healthy" });
      }
    }
    const outs = await readAction(
      rigOf(new EmptyStreamNode()),
      [["s://empty"]],
      sig(),
    );
    assertEquals(outs.length, 1);
    assertEquals(outs[0][0], "s://empty");
    assertEquals(outs[0][1] instanceof Uint8Array, true);
    assertEquals((outs[0][1] as Uint8Array).length, 0);
    // The distinction load-bearing: missing → `null`; empty bytes →
    // Uint8Array(0). Both must round-trip.
    assertEquals(outs[0][1] === null, false);
  },
);

// ── mid-stream error ───────────────────────────────────────────────────

Deno.test(
  "readAction: mid-stream error propagates and rejects the whole batch",
  async () => {
    // One slot streams fine, another errors mid-stream. The action's
    // `Promise.all` rejects with the inner error; the verdict's
    // sibling-drain concern (in-flight reads on other slots may still
    // run to completion) is documented at the action's JSDoc — this
    // test does not assert cleanup of siblings, only that the whole
    // batch fails fast with the right error message.
    class MixedErrorNode implements ProtocolInterfaceNode {
      read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
        return Promise.resolve(urls.map((u): Output<T> => {
          if (u === "s://boom") {
            const stream = new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(new TextEncoder().encode("partial"));
                c.error(new Error("boom"));
              },
            });
            return [u, stream] as unknown as Output<T>;
          }
          // Sibling slot: a stream that completes cleanly.
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode("ok"));
              c.close();
            },
          });
          return [u, stream] as unknown as Output<T>;
        }));
      }
      receive(): Promise<ReceiveResult[]> {
        return Promise.resolve([]);
      }
      async *observe(): AsyncIterable<readonly string[]> {
        yield [] as readonly string[];
      }
      status(): Promise<StatusResult> {
        return Promise.resolve({ status: "healthy" });
      }
    }
    const err = await assertRejects(
      () =>
        readAction(
          rigOf(new MixedErrorNode()),
          [["s://ok", "s://boom"]],
          sig(),
        ),
      Error,
    );
    // `pipeTo` wraps the source error; the message bubbles up.
    assertEquals(
      err instanceof Error && err.message.includes("boom"),
      true,
      `expected error to mention "boom", got: ${err.message}`,
    );
  },
);

// ── ReadableStream<string> duck-type ──────────────────────────────────

Deno.test(
  "readAction: ReadableStream<string> payload — duck-type accepts it; pipeTo rejects on non-Uint8Array chunk",
  async () => {
    // Today's `materializeStreams` duck-types on `.getReader`, so a
    // string stream qualifies. The WritableStream<Uint8Array> sink
    // then refuses the string chunk. Result: the batch rejects.
    //
    // This pins the gap from the verdict ("duck-type accepts
    // ReadableStream<string>") — the day someone tightens the check
    // (e.g. branches on the first chunk's type and TextEncoder-wraps
    // strings), update this test to assert the lossy-encoded bytes
    // round-trip.
    class StringStreamNode implements ProtocolInterfaceNode {
      read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
        return Promise.resolve(urls.map((u): Output<T> => {
          const stream = new ReadableStream<string>({
            start(c) {
              c.enqueue("hello");
              c.close();
            },
          });
          return [u, stream] as unknown as Output<T>;
        }));
      }
      receive(): Promise<ReceiveResult[]> {
        return Promise.resolve([]);
      }
      async *observe(): AsyncIterable<readonly string[]> {
        yield [] as readonly string[];
      }
      status(): Promise<StatusResult> {
        return Promise.resolve({ status: "healthy" });
      }
    }
    await assertRejects(
      () =>
        readAction(
          rigOf(new StringStreamNode()),
          [["s://str"]],
          sig(),
        ),
      Error,
    );
  },
);

// ── cross-realm-like ReadableStream lock ──────────────────────────────

Deno.test(
  "readAction: duck-type (not instanceof) is preserved — pseudo-stream off the prototype still materializes",
  async () => {
    // If a future change regresses `materializeStreams` from
    // duck-type to `instanceof ReadableStream`, a stream coming from
    // a different realm (or a polyfill, or this hand-rolled mock)
    // would fall through unmaterialized and break the wire. This test
    // builds a minimal stream-like with `getReader()` and confirms
    // the materializer accepts it.
    const fakeBytes = new TextEncoder().encode("from-pseudo-stream");
    let drained = false;
    const pseudoStream = {
      getReader() {
        let done = false;
        return {
          read(): Promise<{ done: boolean; value?: Uint8Array }> {
            if (done) return Promise.resolve({ done: true });
            done = true;
            return Promise.resolve({ done: false, value: fakeBytes });
          },
          releaseLock() {},
          cancel() {
            return Promise.resolve();
          },
          closed: Promise.resolve(),
        };
      },
      // Real ReadableStream.pipeTo would be called by the materializer,
      // so wire that too — it just consumes the reader and signals done.
      pipeTo(sink: WritableStream<Uint8Array>): Promise<void> {
        return (async () => {
          const writer = sink.getWriter();
          await writer.write(fakeBytes);
          await writer.close();
          drained = true;
        })();
      },
    };
    class PseudoStreamNode implements ProtocolInterfaceNode {
      read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
        return Promise.resolve(
          urls.map((u): Output<T> => [u, pseudoStream] as unknown as Output<T>),
        );
      }
      receive(): Promise<ReceiveResult[]> {
        return Promise.resolve([]);
      }
      async *observe(): AsyncIterable<readonly string[]> {
        yield [] as readonly string[];
      }
      status(): Promise<StatusResult> {
        return Promise.resolve({ status: "healthy" });
      }
    }
    const outs = await readAction(
      rigOf(new PseudoStreamNode()),
      [["s://pseudo"]],
      sig(),
    );
    assertEquals(outs.length, 1);
    assertEquals(outs[0][1] instanceof Uint8Array, true);
    assertEquals(
      new TextDecoder().decode(outs[0][1] as Uint8Array),
      "from-pseudo-stream",
    );
    assertEquals(drained, true);
  },
);
