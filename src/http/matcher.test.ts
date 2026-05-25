/// <reference lib="deno.ns" />
/**
 * httpRequest: the common-case matcher generator in isolation.
 *
 * Behavioural pins:
 *  - segment count must match exactly
 *  - `:name` captures into params
 *  - empty capture (trailing slash) does not match
 *  - method-mismatch returns `{ allow }`, not `null`
 *  - multi-method list participates in allow on miss
 */

import { assertEquals } from "@std/assert";
import { httpRequest } from "./router.ts";

function req(path: string, method = "GET"): Request {
  return new Request(`http://test${path}`, { method });
}

Deno.test("httpRequest: exact path + method → { params: {} }", () => {
  const m = httpRequest("GET", "/api/v1/status");
  assertEquals(m(req("/api/v1/status")), { params: {} });
});

Deno.test("httpRequest: literal mismatch → null", () => {
  const m = httpRequest("GET", "/api/v1/status");
  assertEquals(m(req("/api/v1/other")), null);
});

Deno.test("httpRequest: segment count mismatch → null", () => {
  const m = httpRequest("GET", "/api/v1/status");
  assertEquals(m(req("/api/v1/status/extra")), null);
  assertEquals(m(req("/api/v1")), null);
});

Deno.test("httpRequest: :name captures one segment into params", () => {
  const m = httpRequest("GET", "/api/v1/content/:uri");
  assertEquals(m(req("/api/v1/content/abc")), { params: { uri: "abc" } });
});

Deno.test("httpRequest: multiple :name captures", () => {
  const m = httpRequest("GET", "/x/:a/:b");
  assertEquals(m(req("/x/one/two")), { params: { a: "one", b: "two" } });
});

Deno.test("httpRequest: :name does not URL-decode (host's responsibility)", () => {
  const m = httpRequest("GET", "/x/:uri");
  assertEquals(m(req("/x/abc%2Fdef")), { params: { uri: "abc%2Fdef" } });
});

Deno.test("httpRequest: empty :name capture (trailing slash) → null", () => {
  const m = httpRequest("GET", "/x/:p");
  assertEquals(m(req("/x/")), null);
});

Deno.test("httpRequest: method mismatch → { allow }", () => {
  const m = httpRequest("GET", "/api/v1/x");
  assertEquals(m(req("/api/v1/x", "POST")), { allow: ["GET"] });
});

Deno.test("httpRequest: multi-method list accepts each method", () => {
  const m = httpRequest(["GET", "POST"], "/x");
  assertEquals(m(req("/x", "GET")), { params: {} });
  assertEquals(m(req("/x", "POST")), { params: {} });
});

Deno.test("httpRequest: multi-method list returns full list on miss", () => {
  const m = httpRequest(["GET", "POST"], "/x");
  assertEquals(m(req("/x", "DELETE")), { allow: ["GET", "POST"] });
});

Deno.test("httpRequest: path mismatch beats method mismatch (returns null)", () => {
  const m = httpRequest("GET", "/x");
  // No path match → null, not { allow }. Otherwise every route would
  // contribute to 405 for every unmatched path.
  assertEquals(m(req("/elsewhere", "POST")), null);
});
