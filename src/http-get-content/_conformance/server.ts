/**
 * GET-content facet test server.
 *
 * Content transports are NOT PIN-symmetric — bespoke rig, content-type
 * mapping, browser-only assertions — so they do not plug into the shared
 * `runMoveSuite`. This is their own co-located server boot: a small
 * deterministic rig behind `httpGetContentApi`, wrapped in `withCors` for
 * the cross-origin browser client. The browser harness asserts the wire
 * shape end-to-end:
 *
 *   read(`mutable://t/*.png`)  → bytes field + image/png
 *   read(`mutable://t/*.txt`)  → text field  + text/plain
 *   read(`mutable://t/thing`)  → { echo, kind: "obj" } as JSON
 *   read(`mutable://t/__miss__/`) → null payload
 *
 * Publish-excluded test support (see `deno.json`).
 */

/// <reference lib="deno.ns" />

import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import type { ServerHandle } from "../../../tests/suites/move-plug.ts";
import { httpGetContentApi } from "../service.ts";
import { payloadResponseMap as map } from "../payload-response-map.ts";
import { withCors } from "../../cors.ts";

class ContentStubBackend implements ProtocolInterfaceNode {
  receive(msgs: Output[]): Promise<ReceiveResult[]> {
    return Promise.resolve(msgs.map(() => ({ accepted: true })));
  }
  read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
    return Promise.resolve(urls.map((url): Output<T> => {
      if (url.includes("/__miss__/")) return [url, null as unknown as T];
      if (url.endsWith(".png")) {
        return [url, {
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          kind: "image",
        } as unknown as T];
      }
      if (url.endsWith(".txt")) {
        return [url, { text: "hello", kind: "text" } as unknown as T];
      }
      return [url, { echo: url, kind: "obj" } as unknown as T];
    }));
  }
  // deno-lint-ignore require-yield
  async *observe(): AsyncIterable<readonly string[]> {
    return;
  }
  status(): Promise<StatusResult> {
    return Promise.resolve({ status: "healthy" });
  }
}

function buildRig(): Rig {
  const route = connection(new ContentStubBackend(), ["**"]);
  return new Rig({ routes: { receive: [route], read: [route] } });
}

export function startHttpGetContentServer(): Promise<ServerHandle> {
  const api = httpGetContentApi(buildRig(), {
    payloadResponseMap: map.byExtension({
      png: map.fromField("bytes", { contentType: "image/png" }),
      txt: map.fromField("text", { contentType: "text/plain" }),
      "*": map.json(),
    }),
  });
  const handler = withCors(api, { origin: "*" });
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    handler,
  );
  const { port } = server.addr as Deno.NetAddr;
  return Promise.resolve({
    url: `http://127.0.0.1:${port}`,
    stop: () => server.shutdown(),
  });
}
