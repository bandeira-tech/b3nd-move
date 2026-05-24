/// <reference lib="deno.ns" />
/**
 * text codec: string payload ↔ text body with configurable content-type.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { text } from "./text.ts";

const REQ = new Request("http://x");

Deno.test("text.encode: default content-type is text/plain", async () => {
  const init = await text().encode(REQ, ["u", "hello"]);
  assertEquals(init.body, "hello");
  assertEquals(
    (init.headers as Record<string, string>)["Content-Type"],
    "text/plain",
  );
});

Deno.test("text.encode: custom content-type is forwarded", async () => {
  const init = await text("text/markdown").encode(REQ, ["u", "# h"]);
  assertEquals(
    (init.headers as Record<string, string>)["Content-Type"],
    "text/markdown",
  );
});

Deno.test("text.encode: non-string payload → TypeError", () => {
  const c = text();
  // Synchronous throw — the encode wraps a sync TypeError before await.
  assertThrows(
    () => {
      void c.encode(REQ, ["u", 123 as unknown as string]);
    },
    TypeError,
    "payload must be a string",
  );
});

Deno.test("text.decode: reads body as string", async () => {
  const req = new Request("http://x", {
    method: "POST",
    body: "raw text",
    headers: { "Content-Type": "text/plain" },
  });
  assertEquals(await text().decode(req), "raw text");
});
