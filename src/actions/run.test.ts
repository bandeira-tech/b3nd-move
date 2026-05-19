/// <reference lib="deno.ns" />
/**
 * runAction: each action dispatches to the corresponding rig method
 * and forwards args/return faithfully.
 */

import { assertEquals } from "@std/assert";
import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { runAction } from "./run.ts";

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
  ): AsyncIterable<Output<string[]>> {
    this.seen.push({ fn: "observe", args: [urls] });
    for (const u of urls) {
      yield [u, [`${u}/0`]];
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

Deno.test("runAction status → StatusResult", async () => {
  const { rig } = buildRig();
  const out = await runAction(rig, { action: "status" });
  assertEquals(out.status, "healthy");
});

Deno.test("runAction receive → ReceiveResult[]", async () => {
  const { rig } = buildRig();
  const outputs: Output[] = [
    ["mutable://t/x", { v: 1 }],
    ["mutable://t/y", { v: 2 }],
  ];
  const results = await runAction(rig, { action: "receive", outputs });
  assertEquals(results.length, 2);
  assertEquals(results.every((r) => r.accepted), true);
});

Deno.test("runAction read → Output[]", async () => {
  const { rig } = buildRig();
  const urls = ["mutable://t/a", "mutable://t/b"];
  const outs = await runAction(rig, { action: "read", urls });
  assertEquals(outs.length, 2);
  assertEquals(outs[0][0], "mutable://t/a");
  assertEquals(outs[1][0], "mutable://t/b");
});

Deno.test("runAction observe → AsyncIterable streams frames", async () => {
  const { rig } = buildRig();
  const abort = new AbortController();
  const frames: Output<string[]>[] = [];
  for await (
    const frame of runAction(rig, {
      action: "observe",
      urls: ["mutable://t/p"],
      signal: abort.signal,
    })
  ) {
    frames.push(frame);
    if (frames.length >= 1) {
      abort.abort();
      break;
    }
  }
  assertEquals(frames.length >= 1, true);
  assertEquals(frames[0][0], "mutable://t/p");
});
