import { assertEquals } from "@std/assert";
import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { grpcHttpApi } from "./service.ts";
import { stubRig } from "../../../tests/rigs/stub.ts";
import { grpcProto } from "../../codecs/grpc/mod.ts";

const codec = grpcProto();

function post(
  handler: (req: Request) => Promise<Response>,
  method: string,
  body: unknown,
  contentType = "application/json",
): Promise<Response> {
  return handler(
    new Request(`http://localhost/b3nd.v1.B3ndService/${method}`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: JSON.stringify(body),
    }),
  );
}

// Encode an arbitrary JS payload to base64-of-UTF-8-JSON — the wire form
// that @bufbuild/protobuf produces for the `bytes payload` field in JSON
// transport.
function payloadJson(value: unknown): string {
  return btoa(JSON.stringify(value));
}

Deno.test("Receive — relays accept ack from rig", async () => {
  const handler = grpcHttpApi(stubRig(), { codec });
  const resp = await post(handler, "Receive", {
    messages: [
      {
        uri: "mutable://test/hello",
        payload: payloadJson({ msg: "world" }),
        payloadIsBinary: false,
      },
    ],
  });
  assertEquals(resp.status, 200);
  const body = await resp.json();
  assertEquals(body.results.length, 1);
  assertEquals(body.results[0].accepted, true);
});

Deno.test("Read — relays rig output payload encoded as JSON bytes", async () => {
  const handler = grpcHttpApi(stubRig(), { codec });
  const resp = await post(handler, "Read", {
    urls: ["mutable://test/hello"],
  });
  assertEquals(resp.status, 200);
  const body = await resp.json();
  assertEquals(body.results.length, 1);
  assertEquals(body.results[0].uri, "mutable://test/hello");
  // stubRig echoes `{ echo: url }` — we assert the wire carries it
  // back as the JSON-encoded payload bytes.
  assertEquals(
    body.results[0].payload,
    payloadJson({ echo: "mutable://test/hello" }),
  );
});

Deno.test("Receive — connect+json Content-Type", async () => {
  const handler = grpcHttpApi(stubRig(), { codec });
  const resp = await post(handler, "Receive", {
    messages: [
      {
        uri: "mutable://test/connect",
        payload: payloadJson({ x: 1 }),
        payloadIsBinary: false,
      },
    ],
  }, "application/connect+json");
  assertEquals(resp.status, 200);
  const body = await resp.json();
  assertEquals(body.results[0].accepted, true);
});

Deno.test("Status — returns healthy", async () => {
  const handler = grpcHttpApi(stubRig(), { codec });
  const resp = await post(handler, "Status", {});
  assertEquals(resp.status, 200);
  assertEquals((await resp.json()).status, "healthy");
});

Deno.test("Receive — empty messages returns 400", async () => {
  const handler = grpcHttpApi(stubRig(), { codec });
  const resp = await post(handler, "Receive", { messages: [] });
  assertEquals(resp.status, 400);
});

Deno.test("Read — missing urls returns 400", async () => {
  const handler = grpcHttpApi(stubRig(), { codec });
  const resp = await post(handler, "Read", { urls: [] });
  assertEquals(resp.status, 400);
});

Deno.test("Unknown method returns 404", async () => {
  const handler = grpcHttpApi(stubRig(), { codec });
  const resp = await post(handler, "Unknown", {});
  assertEquals(resp.status, 404);
});

Deno.test("Non-POST returns 404", async () => {
  const handler = grpcHttpApi(stubRig(), { codec });
  const resp = await handler(
    new Request("http://localhost/b3nd.v1.B3ndService/Status", {
      method: "GET",
    }),
  );
  assertEquals(resp.status, 404);
});

// ── AbortSignal mid-stream cancel (M4 wiring) ──────────────────────────

/**
 * A node whose read returns a stream that enqueues once and never
 * closes. Tracks whether the stream's cancel() was invoked.
 */
class NeverClosingNode implements ProtocolInterfaceNode {
  cancelled = false;
  read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
    return Promise.resolve(urls.map((u): Output<T> => {
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => {
          c.enqueue(new TextEncoder().encode("first"));
          // never close — simulates a slow upstream (fs/s3/ipfs stream)
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

Deno.test(
  "Read — AbortSignal mid-stream cancels upstream stream (M4 wiring)",
  async () => {
    // Proves the per-request AbortSignal propagates from grpcHttpApi
    // through readAction → materializeStreams → pipeTo({ signal }),
    // so aborting the request mid-flight causes the upstream stream's
    // cancel() to fire. Without M4, the stream pump leaks.
    const node = new NeverClosingNode();
    const c = connection(node, ["s://**"]);
    const rig = new Rig({ routes: { receive: [c], read: [c], observe: [c] } });
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

    // The handler may reject (AbortError) or resolve with an error
    // response — we only care that the upstream stream was cancelled.
    try {
      await respP;
    } catch {
      // expected: AbortError or similar
    }

    // Give pipeTo a microtask to invoke cancel().
    await new Promise<void>((r) => setTimeout(r, 10));
    assertEquals(
      node.cancelled,
      true,
      "AbortSignal abort did not propagate to upstream stream cancel() — M4 regression",
    );
  },
);
