/// <reference lib="deno.ns" />
/**
 * Inbound source helpers: HMAC / token verification and JSON decode.
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { Output } from "@bandeira-tech/b3nd-core/types";
import { BadRequest, Unauthorized } from "../../router/errors.ts";
import { hmacSha256Hex } from "../hmac.ts";
import { decode, verify, type WebhookContext } from "./source.ts";

const enc = (s: string) => new TextEncoder().encode(s);

function ctx(
  bodyStr: string,
  headers: Record<string, string> = {},
): WebhookContext {
  const body = enc(bodyStr);
  const h = new Headers(headers);
  return {
    req: new Request("http://test/api/v1/webhooks/in/x", {
      method: "POST",
      body,
      headers: h,
    }),
    body,
    headers: h,
    params: { source: "x" },
  };
}

Deno.test("verify.hmacSha256: valid signature passes", async () => {
  const body = `{"a":1}`;
  const sig = `sha256=${await hmacSha256Hex("topsecret", enc(body))}`;
  const v = verify.hmacSha256({ secret: "topsecret" });
  await v(ctx(body, { "X-B3nd-Signature": sig }));
});

Deno.test("verify.hmacSha256: missing header → Unauthorized", async () => {
  const v = verify.hmacSha256({ secret: "topsecret" });
  await assertRejects(
    () => Promise.resolve(v(ctx(`{}`))),
    Unauthorized,
    "Missing",
  );
});

Deno.test("verify.hmacSha256: wrong secret → Unauthorized (mismatch)", async () => {
  const body = `{"a":1}`;
  const sig = `sha256=${await hmacSha256Hex("wrong", enc(body))}`;
  const v = verify.hmacSha256({ secret: "topsecret" });
  await assertRejects(
    () => Promise.resolve(v(ctx(body, { "X-B3nd-Signature": sig }))),
    Unauthorized,
    "mismatch",
  );
});

Deno.test("verify.hmacSha256: malformed prefix → Unauthorized", async () => {
  const v = verify.hmacSha256({ secret: "topsecret" });
  await assertRejects(
    () => Promise.resolve(v(ctx(`{}`, { "X-B3nd-Signature": "deadbeef" }))),
    Unauthorized,
    "Malformed",
  );
});

Deno.test("verify.hmacSha256: custom header + empty prefix (bare hex)", async () => {
  const body = `payload`;
  const sig = await hmacSha256Hex("s", enc(body));
  const v = verify.hmacSha256({ secret: "s", header: "X-Sig", prefix: "" });
  await v(ctx(body, { "X-Sig": sig }));
});

Deno.test("verify.headerToken: match passes, mismatch → Unauthorized", async () => {
  const v = verify.headerToken({ token: "Bearer abc" });
  await v(ctx(`{}`, { Authorization: "Bearer abc" }));
  await assertRejects(
    async () => await v(ctx(`{}`, { Authorization: "Bearer nope" })),
    Unauthorized,
  );
});

Deno.test("decode.json: parses body and maps to outputs", async () => {
  const d = decode.json((e) => {
    const ev = e as { id: string };
    return [[`mutable://x/${ev.id}`, ev]] as Output[];
  });
  const outputs = await d(ctx(`{"id":"42"}`));
  assertEquals(outputs.length, 1);
  assertEquals(outputs[0][0], "mutable://x/42");
});

Deno.test("decode.json: invalid JSON → BadRequest", async () => {
  const d = decode.json(() => []);
  await assertRejects(
    async () => await d(ctx("not json")),
    BadRequest,
    "Invalid JSON",
  );
});

Deno.test("decode.json: map can fan one delivery into many outputs", async () => {
  const d = decode.json((e) => {
    const ev = e as { items: string[] };
    return ev.items.map((i): Output => [`mutable://x/${i}`, { i }]);
  });
  const outputs = await d(ctx(`{"items":["a","b","c"]}`));
  assertEquals(outputs.map((o) => o[0]), [
    "mutable://x/a",
    "mutable://x/b",
    "mutable://x/c",
  ]);
});
