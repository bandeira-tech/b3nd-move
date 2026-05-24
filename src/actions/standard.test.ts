/// <reference lib="deno.ns" />
/**
 * Standard action functions: each binds the corresponding rig method,
 * forwarding args and the per-request signal.
 */

import { assertEquals } from "@std/assert";
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
  const route = connection(backend, ["*"]);
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
