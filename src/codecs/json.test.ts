/// <reference lib="deno.ns" />
/**
 * json codec: payload ↔ application/json.
 */

import { assertEquals } from "@std/assert";
import { json } from "./json.ts";

const REQ = new Request("http://x");

Deno.test("json.encode: serialises payload, sets application/json", async () => {
  const c = json();
  const init = await c.encode(REQ, ["mutable://x", { a: 1, b: [2] }]);
  assertEquals(init.body, `{"a":1,"b":[2]}`);
  assertEquals(
    (init.headers as Record<string, string>)["Content-Type"],
    "application/json",
  );
});

Deno.test("json.encode: handles primitives, null, arrays", async () => {
  const c = json();
  assertEquals((await c.encode(REQ, ["u", null])).body, `null`);
  assertEquals((await c.encode(REQ, ["u", 42])).body, `42`);
  assertEquals((await c.encode(REQ, ["u", [1, 2]])).body, `[1,2]`);
});

Deno.test("json.decode: parses application/json body", async () => {
  const c = json();
  const req = new Request("http://x", {
    method: "POST",
    body: JSON.stringify({ x: 1 }),
    headers: { "Content-Type": "application/json" },
  });
  assertEquals(await c.decode(req), { x: 1 });
});
