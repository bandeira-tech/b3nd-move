/// <reference lib="deno.ns" />
/**
 * @module
 * gRPC-HTTP read — integration test: rig + `grpcHttpApi(rig)`,
 * end-to-end through the proto wire.
 *
 * Proves the round-3 promise on the gRPC wire: a `ReadableStream<Uint8Array>`
 * upstream payload is materialized at the action layer and arrives at
 * the client as raw bytes via proto's `bytes payload + payloadIsBinary`
 * flag. Unlike WS/MCP, gRPC delivers bytes byte-clean over both binary
 * (proto) and JSON (base64) transports — this test pins that.
 *
 * Background:
 * - PR #50 review M3: gRPC's "stealth correctness fix" — pre-PR, a
 *   stream payload reached `outputToProto` and `JSON.stringify(stream)`
 *   produced `"{}"` on the wire, junk. M4 + readAction-materialize
 *   make this byte-clean.
 * - PR #50 follow-ups room (`immutable://open/cc-chat/20260627143222-pr50-followups/`)
 */

import { assertEquals } from "@std/assert";
import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { grpcHttpApi } from "./service.ts";
import { grpcProto } from "../../codecs/grpc/mod.ts";

const codec = grpcProto();

function post(
  handler: (req: Request) => Promise<Response>,
  method: string,
  body: unknown,
  contentType = "application/json",
  init: RequestInit = {},
): Promise<Response> {
  return handler(
    new Request(`http://localhost/b3nd.v1.B3ndService/${method}`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: JSON.stringify(body),
      ...init,
    }),
  );
}

class StreamingNode implements ProtocolInterfaceNode {
  constructor(private bytes: Uint8Array) {}
  read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
    const bytes = this.bytes;
    return Promise.resolve(urls.map((u): Output<T> => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
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

class NeverClosingNode implements ProtocolInterfaceNode {
  cancelled = false;
  read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
    return Promise.resolve(urls.map((u): Output<T> => {
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => {
          c.enqueue(new TextEncoder().encode("first"));
        },
        cancel: () => {
          this.cancelled = true;
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

function buildRig(node: ProtocolInterfaceNode): Rig {
  const c = connection(node, ["s://**"]);
  return new Rig({
    routes: { receive: [c], read: [c], observe: [c] },
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

Deno.test(
  "gRPC read: ReadableStream payload arrives over binary payload path (JSON transport, base64-encoded bytes)",
  async () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 50]);
    const node = new StreamingNode(bytes);
    const rig = buildRig(node);
    const handler = grpcHttpApi(rig, { codec });

    const resp = await post(handler, "Read", { urls: ["s://x"] });
    assertEquals(resp.status, 200);
    const body = await resp.json() as {
      results: { uri: string; payload: string; payloadIsBinary: boolean }[];
    };
    assertEquals(body.results.length, 1);
    assertEquals(body.results[0].uri, "s://x");
    // Pins the M3 fix: payloadIsBinary === true, payload base64 of raw
    // bytes. Pre-PR-50, a stream payload reached `outputToProto` and
    // got JSON-stringified to `"{}"` — now it's the materialized bytes
    // shipped through the proto `bytes` field.
    assertEquals(body.results[0].payloadIsBinary, true);
    // Decode base64 → bytes; assert byte-equal.
    const decoded = Uint8Array.from(
      atob(body.results[0].payload),
      (c) => c.charCodeAt(0),
    );
    assertEquals(Array.from(decoded), Array.from(bytes));
  },
);

Deno.test(
  "gRPC read: AbortSignal mid-stream cancels read (request abort propagates)",
  async () => {
    // Fire the request with a signal, abort it shortly after, and
    // assert the upstream stream's `cancel()` ran. This proves the
    // gRPC dispatcher passes its per-request signal into readAction
    // and on into materializeStreams (M4 wiring).
    const node = new NeverClosingNode();
    const rig = buildRig(node);
    const handler = grpcHttpApi(rig, { codec });

    const ac = new AbortController();
    const respP = handler(
      new Request("http://localhost/b3nd.v1.B3ndService/Read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: ["s://slow"] }),
        signal: ac.signal,
      }),
    );

    // Give the dispatcher a moment to start the stream pump.
    await new Promise<void>((r) => setTimeout(r, 10));
    ac.abort();

    // The handler's promise rejects (Request signal abort) OR resolves
    // with an error response — we don't assert on that here, only on
    // whether the upstream stream got cancelled. The cancel is the
    // load-bearing observation: without M4 the stream would leak.
    try {
      await respP;
    } catch {
      // expected: AbortError or similar
    }

    // Give pipeTo a microtask to invoke cancel().
    await new Promise<void>((r) => setTimeout(r, 10));
    assertEquals(node.cancelled, true);
  },
);
