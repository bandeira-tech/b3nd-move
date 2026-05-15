import { assertEquals } from "@std/assert";
import { grpcHttpApi } from "./service.ts";
import { testRig } from "../../../tests/rigs/memory.ts";

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

Deno.test("Receive — write and read back", async () => {
  const handler = grpcHttpApi(testRig());

  const receiveResp = await post(handler, "Receive", {
    messages: [
      {
        uri: "mutable://test/hello",
        payload: payloadJson({ msg: "world" }),
        payloadIsBinary: false,
      },
    ],
  });
  assertEquals(receiveResp.status, 200);
  const receiveBody = await receiveResp.json();
  assertEquals(receiveBody.results.length, 1);
  assertEquals(receiveBody.results[0].accepted, true);

  const readResp = await post(handler, "Read", {
    urls: ["mutable://test/hello"],
  });
  assertEquals(readResp.status, 200);
  const readBody = await readResp.json();
  assertEquals(readBody.results.length, 1);
  assertEquals(readBody.results[0].uri, "mutable://test/hello");
  assertEquals(readBody.results[0].payload, payloadJson({ msg: "world" }));
});

Deno.test("Receive — connect+json Content-Type", async () => {
  const handler = grpcHttpApi(testRig());
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
  const handler = grpcHttpApi(testRig());
  const resp = await post(handler, "Status", {});
  assertEquals(resp.status, 200);
  assertEquals((await resp.json()).status, "healthy");
});

Deno.test("Receive — empty messages returns 400", async () => {
  const handler = grpcHttpApi(testRig());
  const resp = await post(handler, "Receive", { messages: [] });
  assertEquals(resp.status, 400);
});

Deno.test("Read — missing urls returns 400", async () => {
  const handler = grpcHttpApi(testRig());
  const resp = await post(handler, "Read", { urls: [] });
  assertEquals(resp.status, 400);
});

Deno.test("Unknown method returns 404", async () => {
  const handler = grpcHttpApi(testRig());
  const resp = await post(handler, "Unknown", {});
  assertEquals(resp.status, 404);
});

Deno.test("Non-POST returns 404", async () => {
  const handler = grpcHttpApi(testRig());
  const resp = await handler(
    new Request("http://localhost/b3nd.v1.B3ndService/Status", {
      method: "GET",
    }),
  );
  assertEquals(resp.status, 404);
});
