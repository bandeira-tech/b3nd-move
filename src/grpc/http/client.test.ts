import { assertEquals } from "@std/assert";
import { grpcHttpApi } from "./service.ts";
import { GrpcHttpClient } from "./client.ts";
import { stubRig } from "../../../tests/rigs/stub.ts";

let nextPort = 19100 + Math.floor(Math.random() * 900);

async function withServer(fn: (url: string) => Promise<void>): Promise<void> {
  const port = nextPort++;
  const server = Deno.serve(
    { port, hostname: "127.0.0.1" },
    grpcHttpApi(stubRig()),
  );
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await server.shutdown();
  }
}

Deno.test("GrpcHttpClient — receive relays rig ack (JSON)", async () => {
  await withServer(async (url) => {
    const client = new GrpcHttpClient({ url });
    const [result] = await client.receive([
      ["mutable://test/item", { value: 42 }],
    ]);
    assertEquals(result.accepted, true);
  });
});

Deno.test("GrpcHttpClient — read decodes rig output payload (JSON)", async () => {
  await withServer(async (url) => {
    const client = new GrpcHttpClient({ url });
    const [[uri, payload]] = await client.read(["mutable://test/item"]);
    assertEquals(uri, "mutable://test/item");
    // stubRig echoes `{ echo: url }` — assert the wire decodes the
    // rig's canned response unchanged.
    assertEquals(payload, { echo: "mutable://test/item" });
  });
});

Deno.test("GrpcHttpClient — read decodes rig output payload (binary)", async () => {
  await withServer(async (url) => {
    const client = new GrpcHttpClient({ url, binary: true });
    const [[, payload]] = await client.read(["mutable://test/binary-item"]);
    assertEquals(payload, { echo: "mutable://test/binary-item" });
  });
});

Deno.test("GrpcHttpClient — batch read preserves slot order", async () => {
  await withServer(async (url) => {
    const client = new GrpcHttpClient({ url });
    const results = await client.read([
      "mutable://test/a",
      "mutable://test/b",
    ]);
    assertEquals(results.length, 2);
    assertEquals(results[0], ["mutable://test/a", { echo: "mutable://test/a" }]);
    assertEquals(results[1], ["mutable://test/b", { echo: "mutable://test/b" }]);
  });
});

Deno.test("GrpcHttpClient — status", async () => {
  await withServer(async (url) => {
    const client = new GrpcHttpClient({ url });
    assertEquals((await client.status()).status, "healthy");
  });
});

Deno.test("GrpcHttpClient — read surfaces stub miss as nullish payload", async () => {
  await withServer(async (url) => {
    const client = new GrpcHttpClient({ url });
    const [[uri, payload]] = await client.read([
      "mutable://test/__miss__/no-such-thing",
    ]);
    assertEquals(uri, "mutable://test/__miss__/no-such-thing");
    assertEquals(payload == null, true);
  });
});
