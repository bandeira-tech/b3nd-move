/// <reference lib="deno.ns" />
/**
 * x-* extension round-trip through the HTTP transport.
 *
 * Pins that:
 *  - `fn=x-<ns>.<name>` survives the wire from client → server,
 *  - extension params (`x-*` keys) reach the executing client intact,
 *  - the server returns the executing client's `Output` unchanged.
 */

import { assertEquals } from "@std/assert";
import { HttpClient } from "./client.ts";
import { buildUrl, parseUrl } from "@bandeira-tech/b3nd-core/url";
import { FunctionalClient } from "@bandeira-tech/b3nd-core";
import { connection } from "@bandeira-tech/b3nd-core/rig";
import { httpApi } from "./service.ts";
import { Rig } from "@bandeira-tech/b3nd-core/rig";
import type { Output } from "@bandeira-tech/b3nd-core/types";

Deno.test("HTTP - x-* extension round-trip", async () => {
  // Echo client: parses each url and returns the parsed { fn, params, ext }
  // as the payload of an Output addressed at the original url.
  const echoClient = new FunctionalClient({
    read: <T = unknown>(urls: string[]) =>
      Promise.resolve(urls.map((url): Output<T> => {
        const parsed = parseUrl(url);
        return [url, {
          fn: parsed.fn,
          params: parsed.params,
          ext: parsed.ext,
        } as T];
      })),
  });

  const serverRig = new Rig({
    routes: { read: [connection(echoClient, ["*"])] },
  });
  const server = Deno.serve(
    { port: 0, onListen() {} },
    httpApi(serverRig),
  );
  const port = server.addr.port;

  try {
    const client = new HttpClient({ url: `http://127.0.0.1:${port}` });

    const url = buildUrl({
      uri: "mutable://things/",
      fn: "x-test.scan",
      params: { limit: 50 },
      ext: { "x-test.cursor": "abc123", "x-test.where": "active=true" },
    });

    const [r] = await client.read<{
      fn: string;
      params: { limit?: number };
      ext: Record<string, string>;
    }>([url]);

    assertEquals(r?.[1].fn, "x-test.scan");
    assertEquals(r?.[1].params.limit, 50);
    assertEquals(r?.[1].ext["x-test.cursor"], "abc123");
    assertEquals(r?.[1].ext["x-test.where"], "active=true");
  } finally {
    await server.shutdown();
  }
});
