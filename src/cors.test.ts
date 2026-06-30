import { assertEquals } from "@std/assert";
import { withCors } from "./cors.ts";

const ok: (req: Request) => Promise<Response> = (_req) =>
  Promise.resolve(
    new Response("body", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    }),
  );

Deno.test("withCors answers OPTIONS preflight with 204 + headers", async () => {
  const handler = withCors(ok, { origin: "*" });
  const res = await handler(
    new Request("http://x/api", { method: "OPTIONS" }),
  );
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(
    res.headers.get("Access-Control-Allow-Methods"),
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  assertEquals(await res.text(), "");
});

Deno.test("withCors merges headers onto the wrapped response, preserving it", async () => {
  const handler = withCors(ok, { origin: "*" });
  const res = await handler(new Request("http://x/api", { method: "GET" }));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Content-Type"), "text/plain");
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(await res.text(), "body");
});

Deno.test("withCors honors a specific origin + custom methods/headers/maxAge", async () => {
  const handler = withCors(ok, {
    origin: "https://app.example.com",
    methods: "GET, POST",
    headers: "X-Custom",
    maxAge: 60,
  });
  const res = await handler(
    new Request("http://x/api", { method: "OPTIONS" }),
  );
  assertEquals(
    res.headers.get("Access-Control-Allow-Origin"),
    "https://app.example.com",
  );
  assertEquals(res.headers.get("Access-Control-Allow-Methods"), "GET, POST");
  assertEquals(res.headers.get("Access-Control-Allow-Headers"), "X-Custom");
  assertEquals(res.headers.get("Access-Control-Max-Age"), "60");
});
