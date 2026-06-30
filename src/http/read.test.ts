/// <reference lib="deno.ns" />

import { assertEquals, assertInstanceOf } from "@std/assert";
import type {
  Output,
  ProtocolInterfaceNode,
} from "@bandeira-tech/b3nd-core/types";
import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import { decodeOutputsFrame } from "../codecs/outputs-frame.ts";
import { encodeUrlList } from "../codecs/url-list.ts";
import { httpApi } from "./service.ts";
import { httpOutputsFrame } from "../codecs/http/mod.ts";

const codec = httpOutputsFrame();

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/**
 * A node whose `read` returns a mix of bytes / stream / null / JSON
 * per the requested URL — exercises every slot shape the wire might
 * see from an upstream client.
 */
class MixedNode implements ProtocolInterfaceNode {
  read<T>(urls: string[]): Promise<Output<T>[]> {
    return Promise.resolve(urls.map((u): Output => {
      if (u === "x://bytes") return [u, enc("raw")];
      if (u === "x://stream") {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc("streamed"));
            c.close();
          },
        });
        return [u, stream];
      }
      if (u === "x://miss") return [u, null];
      if (u === "x://json") return [u, { foo: 1 }];
      return [u, null];
    }) as Output<T>[]);
  }
  receive() {
    return Promise.resolve([]);
  }
  async *observe() {
    yield [] as readonly string[];
  }
  status() {
    return Promise.resolve({ status: "healthy" as const });
  }
}

Deno.test("HTTP read: materializes ReadableStream payloads transparently", async () => {
  const node = new MixedNode();
  const rig = new Rig({
    routes: {
      receive: [connection(node, ["x://**"])],
      read: [connection(node, ["x://**"])],
      observe: [connection(node, ["x://**"])],
    },
  });
  const handler = httpApi(rig, { codec });
  const u = encodeUrlList(["x://stream"]);
  const res = await handler(
    new Request(`http://x/api/v1/read?u=${u}`, { method: "POST" }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/octet-stream");

  const outs = decodeOutputsFrame(new Uint8Array(await res.arrayBuffer()));
  assertEquals(outs.length, 1);
  const [uri, payload] = outs[0];
  assertEquals(uri, "x://stream");
  assertInstanceOf(payload, Uint8Array);
  assertEquals(dec(payload as Uint8Array), "streamed");
});

Deno.test("HTTP read: mixed Uint8Array + ReadableStream + null + JSON-able all round-trip", async () => {
  const node = new MixedNode();
  const rig = new Rig({
    routes: {
      receive: [connection(node, ["x://**"])],
      read: [connection(node, ["x://**"])],
      observe: [connection(node, ["x://**"])],
    },
  });
  const handler = httpApi(rig, { codec });
  const u = encodeUrlList(["x://bytes", "x://stream", "x://miss", "x://json"]);
  const res = await handler(
    new Request(`http://x/api/v1/read?u=${u}`, { method: "POST" }),
  );
  const outs = decodeOutputsFrame(new Uint8Array(await res.arrayBuffer()));
  assertEquals(outs.length, 4);
  assertEquals(outs[0][0], "x://bytes");
  assertEquals(dec(outs[0][1] as Uint8Array), "raw");
  assertEquals(outs[1][0], "x://stream");
  assertEquals(dec(outs[1][1] as Uint8Array), "streamed");
  assertEquals(outs[2][0], "x://miss");
  assertEquals(outs[2][1], null);
  assertEquals(outs[3][0], "x://json");
  assertEquals(outs[3][1], { foo: 1 });
});

Deno.test("HTTP read: concurrent streams are materialized in parallel and preserve order", async () => {
  class SlowStreamNode implements ProtocolInterfaceNode {
    read<T>(urls: string[]): Promise<Output<T>[]> {
      return Promise.resolve(urls.map((u): Output => {
        const stream = new ReadableStream<Uint8Array>({
          async start(c) {
            await new Promise((r) => setTimeout(r, 10));
            c.enqueue(enc(`payload-for-${u}`));
            c.close();
          },
        });
        return [u, stream];
      }) as Output<T>[]);
    }
    receive() {
      return Promise.resolve([]);
    }
    async *observe() {
      yield [] as readonly string[];
    }
    status() {
      return Promise.resolve({ status: "healthy" as const });
    }
  }
  const node = new SlowStreamNode();
  const rig = new Rig({
    routes: {
      receive: [connection(node, ["s://**"])],
      read: [connection(node, ["s://**"])],
      observe: [connection(node, ["s://**"])],
    },
  });
  const handler = httpApi(rig, { codec });
  const urls = ["s://a", "s://b", "s://c", "s://d"];
  const u = encodeUrlList(urls);
  const t0 = performance.now();
  const res = await handler(
    new Request(`http://x/api/v1/read?u=${u}`, { method: "POST" }),
  );
  const elapsed = performance.now() - t0;
  // Each stream sleeps 10ms; in parallel total should be ~10ms, in serial ~40ms.
  // Allow generous headroom for CI jitter.
  assertEquals(elapsed < 35, true, `elapsed=${elapsed}ms suggests serial`);
  const outs = decodeOutputsFrame(new Uint8Array(await res.arrayBuffer()));
  assertEquals(outs.length, 4);
  for (let i = 0; i < 4; i++) {
    assertEquals(outs[i][0], urls[i]);
    assertEquals(dec(outs[i][1] as Uint8Array), `payload-for-${urls[i]}`);
  }
});
