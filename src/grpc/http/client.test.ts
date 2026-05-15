import { assertEquals } from "@std/assert";
import { grpcHttpApi } from "./service.ts";
import { GrpcHttpClient } from "./client.ts";
import { testRig } from "../../../tests/rigs/memory.ts";

let nextPort = 19100 + Math.floor(Math.random() * 900);

async function withServer(fn: (url: string) => Promise<void>): Promise<void> {
  const port = nextPort++;
  const server = Deno.serve(
    { port, hostname: "127.0.0.1" },
    grpcHttpApi(testRig()),
  );
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await server.shutdown();
  }
}

Deno.test("GrpcHttpClient — receive + read round-trip (JSON)", async () => {
  await withServer(async (url) => {
    const client = new GrpcHttpClient({ url });
    const [result] = await client.receive([["mutable://test/item", {
      value: 42,
    }]]);
    assertEquals(result.accepted, true);
    const [[uri, payload]] = await client.read(["mutable://test/item"]);
    assertEquals(uri, "mutable://test/item");
    assertEquals(payload, { value: 42 });
  });
});

Deno.test("GrpcHttpClient — receive + read round-trip (binary)", async () => {
  await withServer(async (url) => {
    const client = new GrpcHttpClient({ url, binary: true });
    const [result] = await client.receive([["mutable://test/binary-item", {
      v: 7,
    }]]);
    assertEquals(result.accepted, true);
    const [[, payload]] = await client.read(["mutable://test/binary-item"]);
    assertEquals(payload, { v: 7 });
  });
});

Deno.test("GrpcHttpClient — batch read", async () => {
  await withServer(async (url) => {
    const client = new GrpcHttpClient({ url });
    await client.receive([["mutable://test/a", { id: "a" }]]);
    await client.receive([["mutable://test/b", { id: "b" }]]);
    const results = await client.read(["mutable://test/a", "mutable://test/b"]);
    assertEquals(results.length, 2);
    assertEquals(results[0], ["mutable://test/a", { id: "a" }]);
    assertEquals(results[1], ["mutable://test/b", { id: "b" }]);
  });
});

Deno.test("GrpcHttpClient — status", async () => {
  await withServer(async (url) => {
    const client = new GrpcHttpClient({ url });
    assertEquals((await client.status()).status, "healthy");
  });
});

Deno.test("GrpcHttpClient — read non-existent URI yields undefined payload", async () => {
  await withServer(async (url) => {
    const client = new GrpcHttpClient({ url });
    const [[uri, payload]] = await client.read([
      "mutable://test/no-such-thing",
    ]);
    assertEquals(uri, "mutable://test/no-such-thing");
    assertEquals(payload, undefined);
  });
});
