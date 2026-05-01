import { assertEquals } from "@std/assert";
import {
  connection,
  MemoryStore,
  Rig,
  SimpleClient,
} from "@bandeira-tech/b3nd-core";
import { grpcHttpApi } from "./service.ts";

function createTestRig(): Rig {
  const client = new SimpleClient(new MemoryStore());
  const route = connection(client, ["*"]);
  return new Rig({ routes: { receive: [route], read: [route] } });
}

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

Deno.test("Receive — write and read back", async () => {
  const handler = grpcHttpApi(createTestRig());

  const receiveResp = await post(handler, "Receive", {
    uri: "mutable://test/hello",
    data: btoa(JSON.stringify({ msg: "world" })),
    dataIsBinary: false,
  });
  assertEquals(receiveResp.status, 200);
  assertEquals((await receiveResp.json()).accepted, true);

  const readResp = await post(handler, "Read", { uris: ["mutable://test/hello"] });
  assertEquals(readResp.status, 200);
  const readResult = await readResp.json();
  assertEquals(readResult.results.length, 1);
  assertEquals(readResult.results[0].success, true);
});

Deno.test("Receive — connect+json Content-Type", async () => {
  const handler = grpcHttpApi(createTestRig());
  const resp = await post(handler, "Receive", {
    uri: "mutable://test/connect",
    data: btoa(JSON.stringify({ x: 1 })),
    dataIsBinary: false,
  }, "application/connect+json");
  assertEquals(resp.status, 200);
  assertEquals((await resp.json()).accepted, true);
});

Deno.test("Status — returns healthy", async () => {
  const handler = grpcHttpApi(createTestRig());
  const resp = await post(handler, "Status", {});
  assertEquals(resp.status, 200);
  assertEquals((await resp.json()).status, "healthy");
});

Deno.test("Receive — missing URI returns 400", async () => {
  const handler = grpcHttpApi(createTestRig());
  const resp = await post(handler, "Receive", { uri: "", data: "", dataIsBinary: false });
  assertEquals(resp.status, 400);
});

Deno.test("Read — missing URIs returns 400", async () => {
  const handler = grpcHttpApi(createTestRig());
  const resp = await post(handler, "Read", { uris: [] });
  assertEquals(resp.status, 400);
});

Deno.test("Unknown method returns 404", async () => {
  const handler = grpcHttpApi(createTestRig());
  const resp = await post(handler, "Unknown", {});
  assertEquals(resp.status, 404);
});

Deno.test("Non-POST returns 404", async () => {
  const handler = grpcHttpApi(createTestRig());
  const resp = await handler(
    new Request("http://localhost/b3nd.v1.B3ndService/Status", { method: "GET" }),
  );
  assertEquals(resp.status, 404);
});
