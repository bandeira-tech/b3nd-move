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
  observeAction,
  readAction,
  receiveAction,
  statusAction,
} from "./standard.ts";

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
