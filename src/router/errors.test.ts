/// <reference lib="deno.ns" />
/**
 * Wire-adapter errors: classes the dispatchers branch on to render
 * status + message.
 */

import { assertEquals } from "@std/assert";
import {
  BadRequest,
  HttpError,
  InternalError,
  NotFound,
  Unauthorized,
} from "./errors.ts";

Deno.test("HttpError: status + message + name preserved on subclass", () => {
  const e = new HttpError(418, "teapot");
  assertEquals(e.status, 418);
  assertEquals(e.message, "teapot");
  assertEquals(e.name, "HttpError");
  assertEquals(e instanceof Error, true);
});

Deno.test("BadRequest: 400 + custom message + name='BadRequest'", () => {
  const e = new BadRequest("bad");
  assertEquals(e.status, 400);
  assertEquals(e.message, "bad");
  assertEquals(e.name, "BadRequest");
  assertEquals(e instanceof HttpError, true);
});

Deno.test("NotFound: 404 default 'Not Found' message; overridable", () => {
  assertEquals(new NotFound().message, "Not Found");
  assertEquals(new NotFound().status, 404);
  assertEquals(new NotFound("gone").message, "gone");
});

Deno.test("Unauthorized: 401 default 'Unauthorized' message; overridable", () => {
  assertEquals(new Unauthorized().message, "Unauthorized");
  assertEquals(new Unauthorized().status, 401);
  assertEquals(new Unauthorized("bad sig").message, "bad sig");
  assertEquals(new Unauthorized().name, "Unauthorized");
  assertEquals(new Unauthorized() instanceof HttpError, true);
});

Deno.test("InternalError: 500 + name='InternalError'", () => {
  const e = new InternalError("hook misbehaved");
  assertEquals(e.status, 500);
  assertEquals(e.name, "InternalError");
  assertEquals(e instanceof HttpError, true);
});

Deno.test("subclasses identify via instanceof HttpError (single discriminant)", () => {
  for (
    const e of [new BadRequest("x"), new NotFound(), new InternalError("y")]
  ) {
    assertEquals(e instanceof HttpError, true);
  }
});
