/**
 * Handler-level tests for `grpcHttpApi(rig)` — wire-protocol concerns
 * that aren't covered by the PIN integration tests in
 * `tests/integration/`: Content-Type negotiation, empty-batch
 * rejection, route/method validation. Calls the handler directly with
 * crafted Request objects; no `Deno.serve`, no network.
 *
 * Round-trip behavior is covered by `moveSuite` in the integration
 * tests against `stubRig`, so we don't reproduce it here.
 */

/// <reference lib="deno.ns" />

import { assertEquals } from "@std/assert";
import { grpcHttpApi } from "./service.ts";
import { stubRig } from "../../../tests/rig.ts";

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

Deno.test("Receive — connect+json Content-Type", async () => {
  const handler = grpcHttpApi(stubRig());
  const resp = await post(handler, "Receive", {
    messages: [
      {
        uri: "mutable://t/connect",
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
  const handler = grpcHttpApi(stubRig());
  const resp = await post(handler, "Status", {});
  assertEquals(resp.status, 200);
  assertEquals((await resp.json()).status, "healthy");
});

Deno.test("Receive — empty messages returns 400", async () => {
  const handler = grpcHttpApi(stubRig());
  const resp = await post(handler, "Receive", { messages: [] });
  assertEquals(resp.status, 400);
});

Deno.test("Read — missing urls returns 400", async () => {
  const handler = grpcHttpApi(stubRig());
  const resp = await post(handler, "Read", { urls: [] });
  assertEquals(resp.status, 400);
});

Deno.test("Unknown method returns 404", async () => {
  const handler = grpcHttpApi(stubRig());
  const resp = await post(handler, "Unknown", {});
  assertEquals(resp.status, 404);
});

Deno.test("Non-POST returns 404", async () => {
  const handler = grpcHttpApi(stubRig());
  const resp = await handler(
    new Request("http://localhost/b3nd.v1.B3ndService/Status", {
      method: "GET",
    }),
  );
  assertEquals(resp.status, 404);
});
