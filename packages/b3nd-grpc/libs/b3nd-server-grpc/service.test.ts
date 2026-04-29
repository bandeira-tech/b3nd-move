import { assertEquals } from "@std/assert";
import {
  connection,
  MemoryStore,
  Rig,
  SimpleClient,
} from "@bandeira-tech/b3nd-core";
import { createGrpcHandler } from "./service.ts";

function createTestRig(): Rig {
  const client = new SimpleClient(new MemoryStore());
  const _route121 = connection(client, ["*"]);
  return new Rig({
    routes: {
      receive: [_route121],
      read: [_route121],
    },
  });
}

function makeRequest(
  handler: (req: Request) => Promise<Response>,
  method: string,
  body: unknown,
): Promise<Response> {
  return handler(
    new Request(`http://localhost/b3nd.v1.B3ndService/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

Deno.test("Receive — write and read back via gRPC handler", async () => {
  const rig = createTestRig();
  const handler = createGrpcHandler(rig);

  // Write
  const receiveResp = await makeRequest(handler, "Receive", {
    uri: "mutable://test/hello",
    data: btoa(
      new TextEncoder().encode(JSON.stringify({ msg: "world" })).reduce(
        (s, b) => s + String.fromCharCode(b),
        "",
      ),
    ),
    dataIsBinary: false,
  });
  assertEquals(receiveResp.status, 200);
  const receiveResult = await receiveResp.json();
  assertEquals(receiveResult.accepted, true);

  // Read back
  const readResp = await makeRequest(handler, "Read", {
    uris: ["mutable://test/hello"],
  });
  assertEquals(readResp.status, 200);
  const readResult = await readResp.json();
  assertEquals(readResult.results.length, 1);
  assertEquals(readResult.results[0].success, true);
});

Deno.test("Status — returns healthy", async () => {
  const rig = createTestRig();
  const handler = createGrpcHandler(rig);

  const resp = await makeRequest(handler, "Status", {});
  assertEquals(resp.status, 200);
  const result = await resp.json();
  assertEquals(result.status, "healthy");
});

Deno.test("Receive — missing URI returns error", async () => {
  const rig = createTestRig();
  const handler = createGrpcHandler(rig);

  const resp = await makeRequest(handler, "Receive", {
    uri: "",
    data: "",
    dataIsBinary: false,
  });
  assertEquals(resp.status, 400);
});

Deno.test("Read — missing URIs returns error", async () => {
  const rig = createTestRig();
  const handler = createGrpcHandler(rig);

  const resp = await makeRequest(handler, "Read", { uris: [] });
  assertEquals(resp.status, 400);
});

Deno.test("Unknown method returns 404", async () => {
  const rig = createTestRig();
  const handler = createGrpcHandler(rig);

  const resp = await makeRequest(handler, "Unknown", {});
  assertEquals(resp.status, 404);
});

Deno.test("Non-POST returns 404", async () => {
  const rig = createTestRig();
  const handler = createGrpcHandler(rig);

  const resp = await handler(
    new Request("http://localhost/b3nd.v1.B3ndService/Status", {
      method: "GET",
    }),
  );
  assertEquals(resp.status, 404);
});
