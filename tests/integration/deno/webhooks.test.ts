/// <reference lib="deno.ns" />
/**
 * Webhooks end-to-end over real `Deno.serve` sockets — the external-HTTP
 * cooperation loop both directions actually cross the wire:
 *
 *   out  a registered subscription delivers `rig.observe` / `rig.read`
 *        results as signed HTTP POSTs to a real receiver.
 *   in   a signed delivery POSTed to `/in/:source` is verified, decoded,
 *        and lands in `rig.receive`.
 *   loop a subscription whose delivery URL is *this same server's* inbound
 *        endpoint — observe frames go out signed and come back in verified,
 *        proving two B3nd nodes cooperate over the webhook wire unchanged.
 */

import { assertEquals } from "@std/assert";
import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { webhooksApi } from "../../../src/webhooks/service.ts";
import { decode, verify } from "../../../src/webhooks/in/source.ts";
import { memoryRegistry } from "../../../src/webhooks/out/service.ts";
import { hmacSha256Hex } from "../../../src/webhooks/hmac.ts";

const enc = (s: string) => new TextEncoder().encode(s);

/** Records receives; echoes reads; emits 2 finite observe frames per url. */
class RecordingBackend implements ProtocolInterfaceNode {
  received: Output[] = [];
  receive(msgs: Output[]): Promise<ReceiveResult[]> {
    this.received.push(...msgs);
    return Promise.resolve(msgs.map(() => ({ accepted: true })));
  }
  read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
    return Promise.resolve(urls.map((u): Output<T> => [u, { echo: u } as T]));
  }
  async *observe(
    urls: string[],
    signal: AbortSignal,
  ): AsyncIterable<readonly string[]> {
    for (const u of urls) {
      for (let i = 0; i < 2; i++) {
        if (signal.aborted) return;
        yield [`${u}/${i}`];
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }
  status(): Promise<StatusResult> {
    return Promise.resolve({ status: "healthy" });
  }
}

function recRig(): { rig: Rig; backend: RecordingBackend } {
  const backend = new RecordingBackend();
  const c = connection(backend, ["**"]);
  return {
    rig: new Rig({ routes: { receive: [c], read: [c], observe: [c] } }),
    backend,
  };
}

interface Hit {
  raw: string;
  body: { type: string; data: Record<string, unknown> };
  sig: string | null;
}

/** A plain HTTP receiver that records every delivery. */
function startReceiver() {
  const hits: Hit[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const raw = await req.text();
      hits.push({
        raw,
        body: JSON.parse(raw),
        sig: req.headers.get("X-B3nd-Signature"),
      });
      return new Response("ok");
    },
  );
  const { port } = server.addr as Deno.NetAddr;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    stop: () => server.shutdown(),
  };
}

function startServer(handler: (req: Request) => Promise<Response>) {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    handler,
  );
  const { port } = server.addr as Deno.NetAddr;
  return { base: `http://127.0.0.1:${port}`, stop: () => server.shutdown() };
}

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

Deno.test("out: subscription delivers signed observe POSTs to a real receiver", async () => {
  const { rig } = recRig();
  const registry = memoryRegistry();
  const srv = startServer(webhooksApi(rig, { out: { registry } }));
  const recv = startReceiver();
  try {
    const res = await fetch(`${srv.base}/api/v1/webhooks/out/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: recv.url,
        urls: ["mutable://t/a"],
        secret: "sec",
      }),
    });
    assertEquals(res.status, 201);
    await res.body?.cancel();

    await waitFor(() => recv.hits.length >= 2);
    assertEquals(recv.hits[0].body.type, "observe");
    assertEquals(recv.hits[0].body.data.urls, ["mutable://t/a/0"]);
    // Signature verifies against the raw delivered bytes.
    const expected = `sha256=${await hmacSha256Hex(
      "sec",
      enc(recv.hits[0].raw),
    )}`;
    assertEquals(recv.hits[0].sig, expected);
  } finally {
    registry.closeAll();
    await recv.stop();
    await srv.stop();
  }
});

Deno.test("out: one-shot read push delivers outputs to a real receiver", async () => {
  const { rig } = recRig();
  const srv = startServer(webhooksApi(rig, { out: {} }));
  const recv = startReceiver();
  try {
    const res = await fetch(`${srv.base}/api/v1/webhooks/out/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: recv.url, urls: ["mutable://t/x"] }),
    });
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.delivered.ok, true);

    await waitFor(() => recv.hits.length >= 1);
    assertEquals(recv.hits[0].body.type, "read");
    const data = recv.hits[0].body.data as { outputs: Output[] };
    assertEquals(data.outputs[0][0], "mutable://t/x");
  } finally {
    await recv.stop();
    await srv.stop();
  }
});

Deno.test("in: signed delivery is verified and reaches rig.receive; bad sig → 401", async () => {
  const { rig, backend } = recRig();
  const srv = startServer(webhooksApi(rig, {
    in: {
      sources: {
        p: {
          verify: verify.hmacSha256({ secret: "sec" }),
          decode: decode.json((e) => [["mutable://in/x", e]] as Output[]),
        },
      },
    },
  }));
  try {
    const body = JSON.stringify({ hello: 1 });
    const sig = `sha256=${await hmacSha256Hex("sec", enc(body))}`;
    const ok = await fetch(`${srv.base}/api/v1/webhooks/in/p`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-B3nd-Signature": sig },
      body,
    });
    assertEquals(ok.status, 200);
    await ok.body?.cancel();
    assertEquals(backend.received.length, 1);
    assertEquals(backend.received[0][0], "mutable://in/x");

    const bad = await fetch(`${srv.base}/api/v1/webhooks/in/p`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-B3nd-Signature": "sha256=bad",
      },
      body,
    });
    assertEquals(bad.status, 401);
    await bad.body?.cancel();
    assertEquals(backend.received.length, 1); // unchanged
  } finally {
    await srv.stop();
  }
});

Deno.test("loop: observe out → signed → back in → rig.receive (node-to-node)", async () => {
  const { rig, backend } = recRig();
  const registry = memoryRegistry();
  // One server, both directions. The inbound "loop" source verifies the
  // same secret the outbound subscription signs with, and maps each
  // delivered observe frame back into an output.
  const handler = webhooksApi(rig, {
    in: {
      sources: {
        loop: {
          verify: verify.hmacSha256({ secret: "sec" }),
          decode: decode.json((e) => {
            const ev = e as { data: { urls: string[] } };
            return ev.data.urls.map((u): Output => [`mutable://loop/${u}`, ev]);
          }),
        },
      },
    },
    out: { registry },
  });
  const srv = startServer(handler);
  try {
    const res = await fetch(`${srv.base}/api/v1/webhooks/out/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: `${srv.base}/api/v1/webhooks/in/loop`,
        urls: ["mutable://t/a"],
        secret: "sec",
      }),
    });
    assertEquals(res.status, 201);
    await res.body?.cancel();

    // 2 observe frames → 2 signed deliveries → 2 verified inbound receives.
    await waitFor(() => backend.received.length >= 2);
    assertEquals(backend.received[0][0], "mutable://loop/mutable://t/a/0");
    assertEquals(backend.received[1][0], "mutable://loop/mutable://t/a/1");
  } finally {
    registry.closeAll();
    await srv.stop();
  }
});
