/// <reference lib="deno.ns" />
/**
 * Move-layer typed errors: transport, timeout, request, encoding.
 *
 * Pins the discriminant API the clients rely on — `kind` tag,
 * `instanceof MoveError` umbrella, and the metadata fields
 * (`status`, `body`, `operation`, `timeoutMs`).
 */

import { assertEquals } from "@std/assert";
import {
  EncodingError,
  MoveError,
  RequestError,
  TimeoutError,
  TransportError,
} from "./errors.ts";

Deno.test("TransportError: kind='transport', transport tag, MoveError instance", () => {
  const e = new TransportError("http", "ECONNREFUSED");
  assertEquals(e.kind, "transport");
  assertEquals(e.transport, "http");
  assertEquals(e.message, "ECONNREFUSED");
  assertEquals(e.name, "TransportError");
  assertEquals(e instanceof MoveError, true);
  assertEquals(e instanceof Error, true);
});

Deno.test("TransportError: cause is preserved via ErrorOptions", () => {
  const cause = new Error("inner");
  const e = new TransportError("ws", "wrap", { cause });
  assertEquals(e.cause, cause);
});

Deno.test("TimeoutError: kind='timeout', formats default message with budget", () => {
  const e = new TimeoutError("http", 5000);
  assertEquals(e.kind, "timeout");
  assertEquals(e.timeoutMs, 5000);
  assertEquals(e.message, "request timed out after 5000ms");
  assertEquals(e.name, "TimeoutError");
  assertEquals(e instanceof MoveError, true);
});

Deno.test("TimeoutError: operation name appears in message when provided", () => {
  const e = new TimeoutError("grpc-http", 30000, "Receive");
  assertEquals(e.message, "Receive timed out after 30000ms");
});

Deno.test("RequestError: kind='request', status/body/operation captured", () => {
  const e = new RequestError("http", "read failed: HTTP 500", {
    status: 500,
    body: "internal",
    operation: "read",
  });
  assertEquals(e.kind, "request");
  assertEquals(e.transport, "http");
  assertEquals(e.status, 500);
  assertEquals(e.body, "internal");
  assertEquals(e.operation, "read");
  assertEquals(e instanceof MoveError, true);
});

Deno.test("RequestError: cause forwarded via init.cause", () => {
  const cause = new Error("inner");
  const e = new RequestError("http", "wrap", { cause });
  assertEquals(e.cause, cause);
});

Deno.test("RequestError: missing fields default to undefined (not present)", () => {
  const e = new RequestError("ws", "bare");
  assertEquals(e.status, undefined);
  assertEquals(e.body, undefined);
  assertEquals(e.operation, undefined);
});

Deno.test("EncodingError: kind='encoding', preserves transport + cause", () => {
  const cause = new SyntaxError("bad json");
  const e = new EncodingError("grpc-http", "frame parse failed", { cause });
  assertEquals(e.kind, "encoding");
  assertEquals(e.transport, "grpc-http");
  assertEquals(e.cause, cause);
  assertEquals(e instanceof MoveError, true);
});

Deno.test("MoveError umbrella catches every leaf class via single instanceof", () => {
  const errs = [
    new TransportError("http", "x"),
    new TimeoutError("http", 100),
    new RequestError("http", "y"),
    new EncodingError("http", "z"),
  ];
  for (const e of errs) assertEquals(e instanceof MoveError, true);
});
