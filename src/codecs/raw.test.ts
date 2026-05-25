/// <reference lib="deno.ns" />
/**
 * raw codec: bytes (Uint8Array | ArrayBuffer | string) ↔ raw body with
 * a fixed content-type.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { raw } from "./raw.ts";

const REQ = new Request("http://x");

Deno.test("raw.encode: Uint8Array payload + fixed content-type", async () => {
  const init = await raw("image/png").encode(REQ, [
    "u",
    new Uint8Array([1, 2, 3]),
  ]);
  assertEquals(
    Array.from(init.body as Uint8Array),
    [1, 2, 3],
  );
  assertEquals(
    (init.headers as Record<string, string>)["Content-Type"],
    "image/png",
  );
});

Deno.test("raw.encode: ArrayBuffer and string payloads accepted", async () => {
  const ab = new Uint8Array([9, 9]).buffer;
  const a = await raw("application/octet-stream").encode(REQ, ["u", ab]);
  assertEquals(a.body, ab as unknown as BodyInit);
  const s = await raw("text/plain").encode(REQ, ["u", "abc"]);
  assertEquals(s.body, "abc");
});

Deno.test("raw.encode: rejects other payload types", () => {
  const c = raw("image/png");
  assertThrows(
    () => {
      void c.encode(REQ, ["u", { not: "bytes" } as unknown as Uint8Array]);
    },
    TypeError,
    "payload must be Uint8Array, ArrayBuffer, or string",
  );
});

Deno.test("raw.decode: returns Uint8Array view of body bytes", async () => {
  const req = new Request("http://x", {
    method: "POST",
    body: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  });
  const out = await raw("application/octet-stream").decode(req);
  assertEquals(Array.from(out as Uint8Array), [0xde, 0xad, 0xbe, 0xef]);
});
