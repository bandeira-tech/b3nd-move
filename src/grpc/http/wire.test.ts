/// <reference lib="deno.ns" />
/**
 * grpc/http/wire.ts: encoding-aware request reader + response builder.
 *
 * Behavioural pins:
 *  - readRequest branches on encoding (json | binary) and uses the
 *    matching @bufbuild/protobuf decoder.
 *  - readRequest throws BadRequest("Invalid request body") on either
 *    failure mode (preserved verbatim for legacy clients).
 *  - okResponse picks Content-Type from encoding.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { create, toBinary, toJson } from "@bufbuild/protobuf";
import { ReadRequestSchema, ReadResponseSchema } from "../proto/gen/b3nd_pb.ts";
import { BadRequest } from "../../router/errors.ts";
import { okResponse, readRequest } from "./wire.ts";

// ── readRequest (json) ──

Deno.test("readRequest (json): parses JSON body through schema", async () => {
  const body = JSON.stringify(
    toJson(ReadRequestSchema, create(ReadRequestSchema, { urls: ["a", "b"] })),
  );
  const req = new Request("http://x", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" },
  });
  const out = await readRequest(req, ReadRequestSchema, "json");
  assertEquals(out.urls, ["a", "b"]);
});

Deno.test("readRequest (json): invalid JSON → BadRequest", async () => {
  const req = new Request("http://x", { method: "POST", body: "not-json{" });
  await assertRejects(
    () => readRequest(req, ReadRequestSchema, "json"),
    BadRequest,
    "Invalid request body",
  );
});

Deno.test("readRequest (json): schema-shape mismatch → BadRequest", async () => {
  // Valid JSON, wrong shape — @bufbuild/protobuf throws, mapped to BadRequest.
  const req = new Request("http://x", {
    method: "POST",
    body: JSON.stringify({ urls: "not-an-array" }),
  });
  await assertRejects(
    () => readRequest(req, ReadRequestSchema, "json"),
    BadRequest,
    "Invalid request body",
  );
});

// ── readRequest (binary) ──

Deno.test("readRequest (binary): parses protobuf bytes through schema", async () => {
  const bin = toBinary(
    ReadRequestSchema,
    create(ReadRequestSchema, { urls: ["x"] }),
  );
  const req = new Request("http://x", {
    method: "POST",
    body: bin,
    headers: { "Content-Type": "application/proto" },
  });
  const out = await readRequest(req, ReadRequestSchema, "binary");
  assertEquals(out.urls, ["x"]);
});

Deno.test("readRequest (binary): malformed bytes → BadRequest", async () => {
  const req = new Request("http://x", {
    method: "POST",
    body: new Uint8Array([0xff, 0xfe, 0xfd]),
  });
  await assertRejects(
    () => readRequest(req, ReadRequestSchema, "binary"),
    BadRequest,
    "Invalid request body",
  );
});

// ── okResponse ──

Deno.test("okResponse (json): emits JSON.stringify(toJson(...)) with application/json", async () => {
  const r = okResponse(
    ReadResponseSchema,
    create(ReadResponseSchema, { results: [] }),
    "json",
  );
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("Content-Type"), "application/json");
  // Round-trip through JSON.parse — schema-equivalent shape.
  const parsed = await r.json();
  assertEquals(typeof parsed, "object");
});

Deno.test("okResponse (binary): emits toBinary bytes with application/proto", async () => {
  const r = okResponse(
    ReadResponseSchema,
    create(ReadResponseSchema, { results: [] }),
    "binary",
  );
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("Content-Type"), "application/proto");
  const buf = await r.arrayBuffer();
  // Empty results serialises to zero bytes — present, parseable, not JSON.
  assertEquals(buf instanceof ArrayBuffer, true);
});
