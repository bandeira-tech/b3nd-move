/// <reference lib="deno.ns" />

import { assertEquals, assertInstanceOf } from "@std/assert";
import type {
  Output,
  ProtocolInterfaceNode,
} from "@bandeira-tech/b3nd-core/types";
import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import { makeReadAction } from "../actions/standard.ts";
import type { Scheduler } from "../actions/scheduler.ts";
import { decodeOutputsFrame } from "../codecs/outputs-frame.ts";
import { encodeUrlList } from "../codecs/url-list.ts";
import { dispatchHttp, httpRequest, route } from "./router.ts";
import { BadRequest } from "../router/errors.ts";
import { encodeOutputsFrame } from "../codecs/outputs-frame.ts";
import { decodeUrlList } from "../codecs/url-list.ts";
import { httpApi } from "./service.ts";

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
  const handler = httpApi(rig);
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
  const handler = httpApi(rig);
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
  const handler = httpApi(rig);
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

// ── Issue #1 cross-transport gate ──────────────────────────────────────
//
// The scheduler seam lives on `readAction`. Every transport route is
// the consumer of an action; this test proves the HTTP transport
// honors a host-injected scheduler end-to-end. The default exported
// `readAction` is `makeReadAction()`; hosts that want their own
// scheduler build a custom route with `makeReadAction(custom)` and
// hand it to the dispatcher.
//
// We rebuild a one-route table here (not via `httpApi`, which uses the
// default-bound `readAction`) so the seam is tested at exactly the
// integration boundary it claims to cover.

Deno.test(
  "HTTP read: host-injected scheduler is honored end-to-end (seam threads through)",
  async () => {
    const node = new MixedNode();
    const rig = new Rig({
      routes: {
        receive: [connection(node, ["x://**"])],
        read: [connection(node, ["x://**"])],
        observe: [connection(node, ["x://**"])],
      },
    });
    let observedSlotCount = -1;
    let calls = 0;
    const scheduler: Scheduler = <T>(
      slots: ReadonlyArray<(signal: AbortSignal) => Promise<T>>,
      signal: AbortSignal,
    ): Promise<T[]> => {
      calls++;
      observedSlotCount = slots.length;
      return Promise.all(slots.map((slot) => slot(signal)));
    };

    // Build a custom read route bound to the injected scheduler. Same
    // wire shape as `./read.ts`; only the action differs.
    const customReadRoute = route({
      on: httpRequest("POST", "/api/v1/read"),
      decode: ({ req }) => {
        const u = new URL(req.url).searchParams.get("u");
        if (!u) throw new BadRequest("Missing ?u= URL list");
        return [decodeUrlList(u)] as const;
      },
      action: makeReadAction(scheduler),
      encode: (outs) =>
        new Response(encodeOutputsFrame(outs) as unknown as BodyInit, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
    });

    const urls = ["x://bytes", "x://stream", "x://json"];
    const u = encodeUrlList(urls);
    const res = await dispatchHttp(
      rig,
      [customReadRoute],
      new Request(`http://x/api/v1/read?u=${u}`, { method: "POST" }),
    );
    assertEquals(res.status, 200);
    assertEquals(calls, 1);
    assertEquals(observedSlotCount, 3);

    const outs = decodeOutputsFrame(new Uint8Array(await res.arrayBuffer()));
    assertEquals(outs.length, 3);
    assertEquals(outs[0][0], "x://bytes");
    assertEquals(dec(outs[0][1] as Uint8Array), "raw");
    assertEquals(outs[1][0], "x://stream");
    assertEquals(dec(outs[1][1] as Uint8Array), "streamed");
    assertEquals(outs[2][0], "x://json");
    assertEquals(outs[2][1], { foo: 1 });
  },
);
