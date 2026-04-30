import { assertEquals } from "@std/assert";
import {
  connection,
  MemoryStore,
  Rig,
  SimpleClient,
} from "@bandeira-tech/b3nd-core";
import { grpcApi } from "../b3nd-server-grpc/service.ts";
import { GrpcClient } from "./mod.ts";

// Use a random high port to avoid conflicts in parallel test runs
let nextPort = 19000 + Math.floor(Math.random() * 1000);

function createTestRig(): Rig {
  const client = new SimpleClient(new MemoryStore());
  const _route122 = connection(client, ["*"]);
  return new Rig({
    routes: {
      receive: [_route122],
      read: [_route122],
    },
  });
}

async function withServer(
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const rig = createTestRig();
  const handler = grpcApi(rig);
  const port = nextPort++;

  const server = Deno.serve({ port, hostname: "127.0.0.1" }, handler);

  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await server.shutdown();
  }
}

Deno.test("GrpcClient round-trip: receive + read", async () => {
  await withServer(async (url) => {
    const client = new GrpcClient({ url });

    // Write
    const results = await client.receive([
      ["mutable://test/grpc-roundtrip", { value: 42 }],
    ]);
    assertEquals(results.length, 1);
    assertEquals(results[0].accepted, true);

    // Read back
    const readResults = await client.read("mutable://test/grpc-roundtrip");
    assertEquals(readResults.length, 1);
    assertEquals(readResults[0].success, true);
    assertEquals(readResults[0].record?.data, { value: 42 });
  });
});

Deno.test("GrpcClient status", async () => {
  await withServer(async (url) => {
    const client = new GrpcClient({ url });
    const status = await client.status();
    assertEquals(status.status, "healthy");
  });
});

Deno.test("GrpcClient read non-existent URI", async () => {
  await withServer(async (url) => {
    const client = new GrpcClient({ url });
    const results = await client.read("mutable://test/nonexistent");
    assertEquals(results.length, 1);
    assertEquals(results[0].success, false);
  });
});

Deno.test("GrpcClient batch read", async () => {
  await withServer(async (url) => {
    const client = new GrpcClient({ url });

    // Write two items
    await client.receive([
      ["mutable://test/batch/a", { id: "a" }],
    ]);
    await client.receive([
      ["mutable://test/batch/b", { id: "b" }],
    ]);

    // Batch read
    const results = await client.read([
      "mutable://test/batch/a",
      "mutable://test/batch/b",
    ]);
    assertEquals(results.length, 2);
    assertEquals(results[0].success, true);
    assertEquals(results[1].success, true);
  });
});
