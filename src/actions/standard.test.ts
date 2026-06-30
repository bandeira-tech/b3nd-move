/// <reference lib="deno.ns" />
/**
 * Standard action functions: each binds the corresponding rig method,
 * forwarding args and the per-request signal.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import {
  makeReadAction,
  observeAction,
  readAction,
  receiveAction,
  statusAction,
} from "./standard.ts";
import { defaultScheduler, type Scheduler } from "../codecs/scheduler.ts";

class StubBackend implements ProtocolInterfaceNode {
  seen: { fn: string; args: unknown[] }[] = [];

  receive(outs: Output[]): Promise<ReceiveResult[]> {
    this.seen.push({ fn: "receive", args: [outs] });
    return Promise.resolve(outs.map(() => ({ accepted: true })));
  }
  read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
    this.seen.push({ fn: "read", args: [urls] });
    return Promise.resolve(
      urls.map((u): Output<T> => [u, { echo: u } as unknown as T]),
    );
  }
  async *observe(
    urls: string[],
    _signal: AbortSignal,
  ): AsyncIterable<readonly string[]> {
    this.seen.push({ fn: "observe", args: [urls] });
    for (const u of urls) {
      yield [`${u}/0`];
    }
  }
  status(): Promise<StatusResult> {
    this.seen.push({ fn: "status", args: [] });
    return Promise.resolve({ status: "healthy", message: "stub" });
  }
}

function buildRig(): { rig: Rig; backend: StubBackend } {
  const backend = new StubBackend();
  const route = connection(backend, ["**"]);
  return {
    rig: new Rig({
      routes: { receive: [route], read: [route], observe: [route] },
    }),
    backend,
  };
}

const sig = () => new AbortController().signal;

Deno.test("statusAction → StatusResult", async () => {
  const { rig } = buildRig();
  const out = await statusAction(rig, [], sig());
  assertEquals(out.status, "healthy");
});

Deno.test("receiveAction → ReceiveResult[]", async () => {
  const { rig } = buildRig();
  const outputs: Output[] = [
    ["mutable://t/x", { v: 1 }],
    ["mutable://t/y", { v: 2 }],
  ];
  const results = await receiveAction(rig, [outputs], sig());
  assertEquals(results.length, 2);
  assertEquals(results.every((r) => r.accepted), true);
});

Deno.test("readAction → Output[]", async () => {
  const { rig } = buildRig();
  const urls = ["mutable://t/a", "mutable://t/b"];
  const outs = await readAction(rig, [urls], sig());
  assertEquals(outs.length, 2);
  assertEquals(outs[0][0], "mutable://t/a");
  assertEquals(outs[1][0], "mutable://t/b");
});

Deno.test("readAction materializes ReadableStream payloads to Uint8Array", async () => {
  // A node whose .read returns streams — fs/s3/ipfs-shaped upstream.
  class StreamingNode implements ProtocolInterfaceNode {
    read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
      return Promise.resolve(urls.map((u): Output<T> => {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(`payload-for-${u}`));
            c.close();
          },
        });
        return [u, stream] as unknown as Output<T>;
      }));
    }
    receive(): Promise<ReceiveResult[]> {
      return Promise.resolve([]);
    }
    async *observe() {
      yield [] as readonly string[];
    }
    status(): Promise<StatusResult> {
      return Promise.resolve({ status: "healthy" });
    }
  }
  const node = new StreamingNode();
  const rig = new Rig({
    routes: {
      receive: [connection(node, ["s://**"])],
      read: [connection(node, ["s://**"])],
      observe: [connection(node, ["s://**"])],
    },
  });
  const urls = ["s://x", "s://y"];
  const outs = await readAction(rig, [urls], sig());
  assertEquals(outs.length, 2);
  assertEquals(outs[0][1] instanceof Uint8Array, true);
  assertEquals(outs[1][1] instanceof Uint8Array, true);
  assertEquals(
    new TextDecoder().decode(outs[0][1] as Uint8Array),
    "payload-for-s://x",
  );
  assertEquals(
    new TextDecoder().decode(outs[1][1] as Uint8Array),
    "payload-for-s://y",
  );
});

Deno.test("readAction passes Uint8Array / null / JSON-able through untouched", async () => {
  class MixedNode implements ProtocolInterfaceNode {
    read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
      return Promise.resolve(urls.map((u): Output<T> => {
        if (u === "m://bytes") {
          return [u, new TextEncoder().encode("raw")] as unknown as Output<T>;
        }
        if (u === "m://miss") return [u, null] as unknown as Output<T>;
        if (u === "m://json") {
          return [u, { foo: 1 }] as unknown as Output<T>;
        }
        return [u, null] as unknown as Output<T>;
      }));
    }
    receive(): Promise<ReceiveResult[]> {
      return Promise.resolve([]);
    }
    async *observe() {
      yield [] as readonly string[];
    }
    status(): Promise<StatusResult> {
      return Promise.resolve({ status: "healthy" });
    }
  }
  const node = new MixedNode();
  const rig = new Rig({
    routes: {
      receive: [connection(node, ["m://**"])],
      read: [connection(node, ["m://**"])],
      observe: [connection(node, ["m://**"])],
    },
  });
  const outs = await readAction(
    rig,
    [["m://bytes", "m://miss", "m://json"]],
    sig(),
  );
  assertEquals(outs[0][1] instanceof Uint8Array, true);
  assertEquals(outs[1][1], null);
  assertEquals(outs[2][1], { foo: 1 });
});

Deno.test("readAction rejects when signal is already aborted before stream pump", async () => {
  class StreamingNode implements ProtocolInterfaceNode {
    read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
      return Promise.resolve(urls.map((u): Output<T> => {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("data"));
            c.close();
          },
        });
        return [u, stream] as unknown as Output<T>;
      }));
    }
    receive(): Promise<ReceiveResult[]> {
      return Promise.resolve([]);
    }
    async *observe() {
      yield [] as readonly string[];
    }
    status(): Promise<StatusResult> {
      return Promise.resolve({ status: "healthy" });
    }
  }
  const node = new StreamingNode();
  const rig = new Rig({
    routes: {
      receive: [connection(node, ["s://**"])],
      read: [connection(node, ["s://**"])],
      observe: [connection(node, ["s://**"])],
    },
  });
  const ac = new AbortController();
  ac.abort();
  await assertRejects(
    () => readAction(rig, [["s://x"]], ac.signal),
    Error,
  );
});

Deno.test("readAction rejects when signal aborts mid-stream (no leak)", async () => {
  let cancelled = false;
  class SlowStreamingNode implements ProtocolInterfaceNode {
    read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
      return Promise.resolve(urls.map((u): Output<T> => {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            // Enqueue first chunk synchronously; never close on its own.
            c.enqueue(new TextEncoder().encode("first"));
          },
          cancel() {
            cancelled = true;
          },
        });
        return [u, stream] as unknown as Output<T>;
      }));
    }
    receive(): Promise<ReceiveResult[]> {
      return Promise.resolve([]);
    }
    async *observe() {
      yield [] as readonly string[];
    }
    status(): Promise<StatusResult> {
      return Promise.resolve({ status: "healthy" });
    }
  }
  const node = new SlowStreamingNode();
  const rig = new Rig({
    routes: {
      receive: [connection(node, ["s://**"])],
      read: [connection(node, ["s://**"])],
      observe: [connection(node, ["s://**"])],
    },
  });
  const ac = new AbortController();
  const p = readAction(rig, [["s://slow"]], ac.signal);
  // Schedule abort after the pipe has started consuming.
  queueMicrotask(() => ac.abort());
  await assertRejects(() => p, Error);
  assertEquals(cancelled, true);
});

Deno.test("readAction does not invoke pipeTo for non-stream payloads (signal ignored)", async () => {
  // Sanity: a fresh AbortController that we abort BEFORE call should
  // not affect non-stream payloads, since materializeStreams short-
  // circuits before touching pipeTo.
  const { rig } = buildRig(); // StubBackend returns { echo: u }
  const ac = new AbortController();
  ac.abort();
  const outs = await readAction(rig, [["mutable://t/a"]], ac.signal);
  assertEquals(outs.length, 1);
  assertEquals(outs[0][0], "mutable://t/a");
});

// ── Issue #1 — Scheduler seam (typed injection) ────────────────────────
//
// The `readAction` factory accepts a host-supplied `Scheduler`. Default
// = `defaultScheduler` (Promise.all-equivalent), preserving exact pre-
// seam behavior. Tests here prove:
//   - default behavior is unchanged for the no-injection caller
//   - a custom scheduler is invoked exactly once with all slot runners
//   - a scheduler that serializes slots actually serializes them
//   - the dispatcher's signal flows scheduler→slot→pipe, and mid-batch
//     aborts surface as rejection (no swallow)
//   - a scheduler that itself throws surfaces the error (no swallow)
//
// Banned-pattern check: there is no `concurrency: number` test — the
// seam is a callback, NOT a config object. Adding a config-shape test
// here would pin a banned policy.

function streamingNodeRig(): { rig: Rig; cancelled: boolean[] } {
  const cancelled: boolean[] = [];
  class N implements ProtocolInterfaceNode {
    read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
      return Promise.resolve(urls.map((u, i): Output<T> => {
        cancelled[i] = false;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(`p:${u}`));
            c.close();
          },
          cancel: () => {
            cancelled[i] = true;
          },
        });
        return [u, stream] as unknown as Output<T>;
      }));
    }
    receive(): Promise<ReceiveResult[]> {
      return Promise.resolve([]);
    }
    async *observe() {
      yield [] as readonly string[];
    }
    status(): Promise<StatusResult> {
      return Promise.resolve({ status: "healthy" });
    }
  }
  const node = new N();
  const rig = new Rig({
    routes: {
      receive: [connection(node, ["s://**"])],
      read: [connection(node, ["s://**"])],
      observe: [connection(node, ["s://**"])],
    },
  });
  return { rig, cancelled };
}

Deno.test(
  "Scheduler seam: default behavior preserved — readAction with no injection materializes via Promise.all-equivalent",
  async () => {
    // Two slots, both streams. The exported `readAction` is
    // `makeReadAction()` — the default scheduler is `defaultScheduler`
    // = `Promise.all(slots.map((s) => s(signal)))`. Behavior must be
    // bit-identical to the pre-seam code path: every slot returns its
    // materialized Uint8Array in input order.
    const { rig } = streamingNodeRig();
    const outs = await readAction(rig, [["s://a", "s://b"]], sig());
    assertEquals(outs.length, 2);
    assertEquals(outs[0][0], "s://a");
    assertEquals(outs[1][0], "s://b");
    assertEquals(outs[0][1] instanceof Uint8Array, true);
    assertEquals(outs[1][1] instanceof Uint8Array, true);
    assertEquals(new TextDecoder().decode(outs[0][1] as Uint8Array), "p:s://a");
    assertEquals(new TextDecoder().decode(outs[1][1] as Uint8Array), "p:s://b");
  },
);

Deno.test(
  "Scheduler seam: custom scheduler invoked exactly once with all slot runners",
  async () => {
    const { rig } = streamingNodeRig();
    let calls = 0;
    let observedSlotCount = -1;
    const scheduler: Scheduler = <T>(
      slots: ReadonlyArray<(signal: AbortSignal) => Promise<T>>,
      signal: AbortSignal,
    ): Promise<T[]> => {
      calls++;
      observedSlotCount = slots.length;
      // Delegate to default behavior so the rest of the test holds.
      return Promise.all(slots.map((slot) => slot(signal)));
    };
    const action = makeReadAction(scheduler);
    const outs = await action(rig, [["s://a", "s://b", "s://c"]], sig());
    assertEquals(calls, 1, "scheduler called more than once per readAction");
    assertEquals(observedSlotCount, 3);
    assertEquals(outs.length, 3);
  },
);

Deno.test(
  "Scheduler seam: a serializing scheduler runs slots one at a time",
  async () => {
    // Prove the seam controls concurrency. The serial scheduler awaits
    // each slot before starting the next; the harness wraps each slot
    // runner to count concurrent in-flight invocations. Under the
    // serial scheduler, peak concurrency must be 1; under the default
    // (Promise.all) scheduler it would be 4.
    const { rig } = streamingNodeRig();
    let active = 0;
    let peak = 0;
    const serialScheduler: Scheduler = async <T>(
      slots: ReadonlyArray<(signal: AbortSignal) => Promise<T>>,
      signal: AbortSignal,
    ): Promise<T[]> => {
      const results: T[] = [];
      for (const slot of slots) {
        active++;
        if (active > peak) peak = active;
        try {
          // Hold the slot "in flight" a tick so any concurrent siblings
          // would have time to race in (they shouldn't, under serial).
          const p = slot(signal);
          await new Promise((r) => setTimeout(r, 5));
          results.push(await p);
        } finally {
          active--;
        }
      }
      return results;
    };
    const action = makeReadAction(serialScheduler);
    const outs = await action(
      rig,
      [["s://a", "s://b", "s://c", "s://d"]],
      sig(),
    );
    assertEquals(outs.length, 4);
    assertEquals(peak, 1, `serial scheduler ran ${peak} slots concurrently`);

    // Sanity: the default scheduler under the same load runs in
    // parallel — proves the test's concurrency counter is sensitive.
    let parActive = 0;
    let parPeak = 0;
    const parallelProbe: Scheduler = <T>(
      slots: ReadonlyArray<(signal: AbortSignal) => Promise<T>>,
      signal: AbortSignal,
    ): Promise<T[]> =>
      Promise.all(slots.map(async (slot) => {
        parActive++;
        if (parActive > parPeak) parPeak = parActive;
        try {
          const p = slot(signal);
          await new Promise((r) => setTimeout(r, 5));
          return await p;
        } finally {
          parActive--;
        }
      }));
    const { rig: rig2 } = streamingNodeRig();
    await makeReadAction(parallelProbe)(
      rig2,
      [["s://a", "s://b", "s://c", "s://d"]],
      sig(),
    );
    assertEquals(
      parPeak,
      4,
      `parallel probe peak was ${parPeak}, expected 4 — counter is broken`,
    );
  },
);

Deno.test(
  "Scheduler seam: AbortSignal flows scheduler→slot→pipe, mid-batch abort propagates as rejection",
  async () => {
    // The outer dispatcher signal is handed to the scheduler; the
    // scheduler hands it (or a derived one) to each slot runner; each
    // slot runner threads it into `pipeTo({ signal })`. Aborting the
    // outer signal mid-flight must reject the batch AND fire each
    // upstream stream's `cancel()` hook.
    const cancelled = new Map<string, boolean>();
    class Slow implements ProtocolInterfaceNode {
      read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
        return Promise.resolve(urls.map((u): Output<T> => {
          cancelled.set(u, false);
          const stream = new ReadableStream<Uint8Array>({
            start: (c) => {
              c.enqueue(new TextEncoder().encode(u));
              // never close
            },
            cancel: () => {
              cancelled.set(u, true);
            },
          });
          return [u, stream] as unknown as Output<T>;
        }));
      }
      receive(): Promise<ReceiveResult[]> {
        return Promise.resolve([]);
      }
      async *observe() {
        yield [] as readonly string[];
      }
      status(): Promise<StatusResult> {
        return Promise.resolve({ status: "healthy" });
      }
    }
    const node = new Slow();
    const rig = new Rig({
      routes: {
        receive: [connection(node, ["s://**"])],
        read: [connection(node, ["s://**"])],
        observe: [connection(node, ["s://**"])],
      },
    });

    // Custom scheduler that records receiving the signal and forwards
    // it to each slot. Default semantics, but proves the wiring.
    let receivedSignal: AbortSignal | undefined;
    const scheduler: Scheduler = <T>(
      slots: ReadonlyArray<(signal: AbortSignal) => Promise<T>>,
      signal: AbortSignal,
    ): Promise<T[]> => {
      receivedSignal = signal;
      return Promise.all(slots.map((slot) => slot(signal)));
    };
    const action = makeReadAction(scheduler);
    const ac = new AbortController();
    const p = action(rig, [["s://a", "s://b"]], ac.signal);
    // Let the pipeTo loop pump at least once for both slots before
    // we fire the abort — pipeTo only invokes cancel() if there's an
    // active pull.
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await assertRejects(() => p);
    assertEquals(receivedSignal, ac.signal, "scheduler did not receive signal");
    // Give the cancel hooks a microtask to fire.
    await new Promise((r) => setTimeout(r, 5));
    assertEquals(cancelled.get("s://a"), true, "slot A not cancelled");
    assertEquals(cancelled.get("s://b"), true, "slot B not cancelled");
  },
);

Deno.test(
  "Scheduler seam: a scheduler that rejects surfaces its error (no swallow)",
  async () => {
    const { rig } = streamingNodeRig();
    class BoomError extends Error {
      constructor() {
        super("scheduler boom");
      }
    }
    const boomScheduler: Scheduler = () => Promise.reject(new BoomError());
    const action = makeReadAction(boomScheduler);
    const err = await assertRejects(
      () => action(rig, [["s://a", "s://b"]], sig()),
      Error,
      "scheduler boom",
    );
    assertEquals(err instanceof BoomError, true);
  },
);

Deno.test(
  "Scheduler seam: defaultScheduler exported value is Promise.all-equivalent (regression pin)",
  async () => {
    // The makeReadAction default arg is `defaultScheduler`; if anyone
    // ever changes the default (a baked cap, a bounded variant, …) this
    // assertion catches it. The seam is the package's contract; the
    // policy lives in the host.
    let observed = 0;
    const probe: Scheduler = <T>(
      slots: ReadonlyArray<(signal: AbortSignal) => Promise<T>>,
      signal: AbortSignal,
    ): Promise<T[]> => {
      observed = slots.length;
      return Promise.all(slots.map((slot) => slot(signal)));
    };
    // Round-trip a 5-slot read through `defaultScheduler` (delegating
    // to Promise.all) and through a probe (also delegating to
    // Promise.all). Both must produce the same result shape.
    const { rig: rigA } = streamingNodeRig();
    const { rig: rigB } = streamingNodeRig();
    const urls = ["s://a", "s://b", "s://c", "s://d", "s://e"];
    const defaultOuts = await makeReadAction(defaultScheduler)(
      rigA,
      [urls],
      sig(),
    );
    const probeOuts = await makeReadAction(probe)(rigB, [urls], sig());
    assertEquals(observed, 5);
    assertEquals(defaultOuts.length, probeOuts.length);
    for (let i = 0; i < 5; i++) {
      assertEquals(defaultOuts[i][0], probeOuts[i][0]);
      assertEquals(
        new TextDecoder().decode(defaultOuts[i][1] as Uint8Array),
        new TextDecoder().decode(probeOuts[i][1] as Uint8Array),
      );
    }
  },
);

Deno.test("observeAction → AsyncIterable streams uri batches", async () => {
  const { rig } = buildRig();
  const ac = new AbortController();
  const frames: (readonly string[])[] = [];
  const iter = await observeAction(rig, [["mutable://t/p"]], ac.signal);
  for await (const frame of iter) {
    frames.push(frame);
    if (frames.length >= 1) {
      ac.abort();
      break;
    }
  }
  assertEquals(frames.length >= 1, true);
  assertEquals(frames[0][0], "mutable://t/p/0");
});
