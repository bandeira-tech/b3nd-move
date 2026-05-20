/// <reference lib="deno.ns" />
/**
 * extractContentUri: prefix matching, decoding, error envelopes.
 */

import { assertEquals } from "@std/assert";
import { CONTENT_PREFIX, extractContentUri } from "./content-uri.ts";

function req(path: string): Request {
  return new Request(`http://test${path}`);
}

Deno.test("extractContentUri: prefix match → decoded URI", () => {
  const uri = "mutable://app/x";
  const r = extractContentUri(
    req(`${CONTENT_PREFIX}${encodeURIComponent(uri)}`),
  );
  assertEquals(r, { uri });
});

Deno.test("extractContentUri: path outside prefix → 404", () => {
  const r = extractContentUri(req("/other/x"));
  assertEquals((r as Response).status, 404);
});

Deno.test("extractContentUri: empty URI after prefix → 404", () => {
  const r = extractContentUri(req(CONTENT_PREFIX));
  assertEquals((r as Response).status, 404);
});

Deno.test("extractContentUri: invalid % encoding → 400", () => {
  // %ZZ is not a valid percent-encoded byte
  const r = extractContentUri(req(`${CONTENT_PREFIX}bad%ZZ`));
  assertEquals((r as Response).status, 400);
});

Deno.test("extractContentUri: complex URI with slashes round-trips", () => {
  const uri = "mutable://app/foo/bar/baz.png";
  const r = extractContentUri(
    req(`${CONTENT_PREFIX}${encodeURIComponent(uri)}`),
  );
  assertEquals(r, { uri });
});
