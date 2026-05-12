/// <reference lib="deno.ns" />
/**
 * HttpClient.read() error handling and ls-mode wire shape.
 *
 * Option-A semantics:
 *  - Transport errors (HTTP 5xx, 4xx, network) **throw** — the client
 *    no longer produces per-url failure results.
 *  - Successful reads return a flat `Output[]` straight from the wire.
 */

import { assertEquals } from "@std/assert";
import { HttpClient } from "./mod.ts";

function createClientWithServer(handler: (req: Request) => Response): {
  client: HttpClient;
  server: Deno.HttpServer;
} {
  const server = Deno.serve({ port: 0, onListen: () => {} }, handler);
  const addr = server.addr as Deno.NetAddr;
  const client = new HttpClient({ url: `http://localhost:${addr.port}` });
  return { client, server };
}

async function expectThrow(fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assertEquals(threw, true, "expected throw");
}

Deno.test("read: HTTP 500 throws", async () => {
  const { client, server } = createClientWithServer(
    () => new Response("Internal Server Error", { status: 500 }),
  );

  try {
    await expectThrow(() => client.read(["mutable://open/test/"]));
  } finally {
    await server.shutdown();
  }
});

Deno.test("read: HTTP 404 throws", async () => {
  const { client, server } = createClientWithServer(
    () => new Response("Not Found", { status: 404 }),
  );

  try {
    await expectThrow(() => client.read(["mutable://open/test/"]));
  } finally {
    await server.shutdown();
  }
});

Deno.test("read: network error throws", async () => {
  const client = new HttpClient({ url: "http://localhost:1" });
  await expectThrow(() => client.read(["mutable://open/test/"]));
});

Deno.test("read: ls-mode passes through Output[] from server", async () => {
  const { client, server } = createClientWithServer(() => {
    const mockOutputs = [
      ["mutable://open/test/item1", { value: 1 }],
      ["mutable://open/test/item2", { value: 2 }],
    ];
    return new Response(JSON.stringify(mockOutputs), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {
    const results = await client.read(["mutable://open/test/"]);
    assertEquals(results.length, 2);
    assertEquals(results[0]?.[0], "mutable://open/test/item1");
    assertEquals(results[0]?.[1], { value: 1 });
    assertEquals(results[1]?.[0], "mutable://open/test/item2");
    assertEquals(results[1]?.[1], { value: 2 });
  } finally {
    await server.shutdown();
  }
});
