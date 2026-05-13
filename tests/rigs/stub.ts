/**
 * Stub rig for browser integration tests.
 *
 * A real `Rig` from b3nd-core backed by a deterministic, content-addressed
 * `ProtocolInterfaceNode`. The point: every transport server in this repo
 * (`httpServer`, `wsServer`, `grpcHttpServer`) is built to take a real
 * Rig — so wrapping a stub PIN in a real Rig lets the browser tests
 * hit the *real* server code path while isolating the result of every
 * operation from any actual storage behavior.
 *
 * Stub contract (the convention every move-suite test relies on):
 *
 *   receive([uri, payload]):
 *     - uri contains "/__reject__/" → { accepted: false, error: "rejected by stub" }
 *     - otherwise                   → { accepted: true,  ref: uri }
 *
 *   read(urls):
 *     - url contains "/__miss__/"   → [url, null]
 *     - url ends with "/"           → synthesized listing of 3 children:
 *                                       [url, [[`${url}0`, {echo}], …]]
 *                                     (used by the HTTP SSE observe
 *                                     endpoint to source its backlog)
 *     - otherwise                   → [url, { echo: url }]
 *
 *   observe(urls):
 *     - emits 3 frames per subscribed pattern: [pattern, [`${pattern}/${i}`]],
 *       then ends.
 *
 *   status():
 *     - { status: "healthy", message: "stub",
 *         fns: ["receive", "read", "observe", "status"] }
 *
 * `null` (not `undefined`) is used to signal a miss because it survives
 * the gRPC-HTTP JSON encoding round-trip — `JSON.stringify(undefined) ===
 * undefined` would write the four-character string "undefined" into the
 * payload bytes and fail to parse back. The move-suite asserts `payload
 * == null`, which is true for both.
 */

/// <reference lib="deno.ns" />

import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Message,
  Output,
  Program,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";

class StubBackend implements ProtocolInterfaceNode {
  // The rig already rejects /__reject__/ at the program stage, so this
  // backend never sees those messages. Every message that reaches the
  // backend is accepted unconditionally.
  receive(msgs: Message[]): Promise<ReceiveResult[]> {
    return Promise.resolve(msgs.map(() => ({ accepted: true })));
  }

  read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
    return Promise.resolve(
      urls.map((url): Output<T> => {
        if (url.endsWith("/")) {
          // The HTTP SSE observe endpoint sources its backlog from a
          // trailing-slash read. Synthesize 3 children so the browser
          // observe test sees 3 emitted events per subscribed pattern.
          const children: Output[] = [];
          for (let i = 0; i < 3; i++) {
            const child = `${url}${i}`;
            children.push([child, { echo: child }]);
          }
          return [url, children as unknown as T];
        }
        if (url.includes("/__miss__/")) {
          return [url, null as unknown as T];
        }
        return [url, { echo: url } as unknown as T];
      }),
    );
  }

  async *observe(
    urls: string[],
    signal: AbortSignal,
  ): AsyncIterable<Output<string[]>> {
    for (const url of urls) {
      for (let i = 0; i < 3; i++) {
        if (signal.aborted) return;
        yield [url, [`${url}/${i}`]];
        // Yield to the event loop so cancellation can interleave.
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }
  }

  status(): Promise<StatusResult> {
    return Promise.resolve({
      status: "healthy",
      message: "stub",
      fns: ["receive", "read", "observe", "status"],
    });
  }
}

/**
 * Program that classifies `/__reject__/` URIs as rejected and
 * everything else as ok. Rejection in the rig must happen at the
 * program stage — the backend's `receive()` return value never
 * surfaces in `rig.receive()`, only the pipeline (program+handler)
 * outcome does. (Backend dispatch runs fire-and-forget after the
 * pipeline accepts; its results are observable on the
 * `OperationHandle` events, not the rig.receive promise.)
 *
 * The program is registered against `mutable://t` — Rig's
 * `_findProgram` matches with `uri === prefix || uri.startsWith(prefix
 * + "/")`, so a prefix without the trailing path segment would miss
 * (e.g. `mutable://` would only match `mutable:///...`).
 */
// deno-lint-ignore require-await
const stubProgram: Program = async (out) => {
  const [uri] = out;
  if (typeof uri === "string" && uri.includes("/__reject__/")) {
    return { code: "rejected", error: "rejected by stub" };
  }
  return { code: "ok" };
};

/**
 * Build a Rig wired to a single `StubBackend` on all three routes,
 * with the `/__reject__/` classifier registered as a program. The
 * same backend instance serves receive, read, and observe — it is
 * stateless so sharing is fine, mirroring the `defaultRig()` shape
 * used by the in-process pinContract factories.
 */
export function stubRig(): Rig {
  const backend = new StubBackend();
  const route = connection(backend, ["*"]);
  return new Rig({
    routes: {
      receive: [route],
      read: [route],
      observe: [route],
    },
    programs: {
      "mutable://t": stubProgram,
    },
  });
}
