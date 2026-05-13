import { assertEquals } from "@std/assert";
import { httpServer } from "./server.ts";

Deno.test("httpServer returns a ServerResolver with transport=http", () => {
  const resolver = httpServer({ port: 3000 });
  assertEquals(resolver.transport, "http");
  assertEquals(typeof resolver.create, "function");
});
