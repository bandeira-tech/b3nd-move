/**
 * In-process `Rig` backed by `MemoryBackend` — a `ProtocolInterfaceNode`
 * whose state is a single `Map<string, unknown>`. Used by every in-Deno
 * integration suite that needs real round-trip semantics (write, read it
 * back, observe a write under a subscribed pattern).
 *
 * This rig deliberately has no dependency on `b3nd-stores` / `b3nd-save`.
 * b3nd-move is the transport layer; tests here verify that the wire
 * faithfully carries values across, not how a Store persists them. A
 * minimal in-process backend is enough to assert wire-level round-trip
 * without re-proving storage semantics.
 *
 * Misses are reported as `[uri, undefined]` — JSON.stringify(undefined)
 * produces 0-length bytes on every transport, decoding back to undefined
 * on the other side.
 */

/// <reference lib="deno.ns" />

import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Message,
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";

interface Subscription {
  patterns: RegExp[];
  urls: string[];
  notify: () => void;
  queue: Output<string[]>[];
}

// Glob → RegExp. Supports `*` (any chars within a path segment-ish
// span) and treats every other char literally. The rig already
// pre-filtered URIs against the connection's `["*"]` pattern, so this
// only needs to be tight enough for the patterns the move-suite
// itself subscribes with (e.g. `mutable://prefix/*`).
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(
    /\*/g,
    ".*",
  );
  return new RegExp(`^${escaped}$`);
}

export class MemoryBackend implements ProtocolInterfaceNode {
  private readonly store = new Map<string, unknown>();
  private readonly subs = new Set<Subscription>();

  receive(msgs: Message[]): Promise<ReceiveResult[]> {
    for (const [uri, payload] of msgs) {
      this.store.set(uri, payload);
      for (const sub of this.subs) {
        for (let i = 0; i < sub.patterns.length; i++) {
          if (sub.patterns[i].test(uri)) {
            sub.queue.push([sub.urls[i], [uri]]);
          }
        }
        if (sub.queue.length > 0) sub.notify();
      }
    }
    return Promise.resolve(msgs.map(() => ({ accepted: true })));
  }

  read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
    return Promise.resolve(
      urls.map((url): Output<T> => {
        if (this.store.has(url)) {
          return [url, this.store.get(url) as T];
        }
        return [url, undefined as unknown as T];
      }),
    );
  }

  async *observe(
    urls: string[],
    signal: AbortSignal,
  ): AsyncIterable<Output<string[]>> {
    const sub: Subscription = {
      patterns: urls.map(globToRegex),
      urls,
      notify: () => {},
      queue: [],
    };

    this.subs.add(sub);
    try {
      while (!signal.aborted) {
        while (sub.queue.length > 0) {
          if (signal.aborted) return;
          yield sub.queue.shift()!;
        }
        if (signal.aborted) return;
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          };
          sub.notify = () => {
            signal.removeEventListener("abort", onAbort);
            sub.notify = () => {};
            resolve();
          };
          signal.addEventListener("abort", onAbort);
        });
      }
    } finally {
      this.subs.delete(sub);
    }
  }

  status(): Promise<StatusResult> {
    return Promise.resolve({
      status: "healthy",
      message: "memory",
      fns: ["receive", "read", "observe", "status"],
    });
  }
}

export function testRig(): Rig {
  const route = connection(new MemoryBackend(), ["*"]);
  return new Rig({
    routes: { receive: [route], read: [route], observe: [route] },
  });
}
