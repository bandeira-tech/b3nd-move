/// <reference lib="deno.ns" />
/**
 * webhooksInApi: source routing, verify/decode dispatch, rig.receive.
 */

import { assertEquals } from "@std/assert";
import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { hmacSha256Hex } from "../hmac.ts";
import { webhooksInApi } from "./service.ts";
import { decode, verify } from "./source.ts";

class StubBackend implements ProtocolInterfaceNode {
  seen: Output[] = [];
  receive(msgs: Output[]): Promise<ReceiveResult[]> {
    this.seen.push(...msgs);
    return Promise.resolve(msgs.map(() => ({ accepted: true })));
  }
  read<T = unknown>(): Promise<Output<T>[]> {
    return Promise.resolve([]);
  }
  // deno-lint-ignore require-yield
  async *observe(): AsyncIterable<readonly string[]> {
    return;
  }
  status(): Promise<StatusResult> {
    return Promise.resolve({ status: "healthy" });
  }
}

function buildRig(): { rig: Rig; backend: StubBackend } {
  const backend = new StubBackend();
  const route = connection(backend, ["**"]);
  return { rig: new Rig({ routes: { receive: [route] } }), backend };
}

const enc = (s: string) => new TextEncoder().encode(s);

// A simple source: maps `{ id }` JSON → one output at `mutable://ev/<id>`.
const simpleDecode = decode.json((e) => {
  const ev = e as { id: string };
  return [[`mutable://ev/${ev.id}`, ev]] as Output[];
});

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://test${path}`, init);
}

Deno.test("unknown source → 404", async () => {
  const { rig } = buildRig();
  const api = webhooksInApi(rig, {
    sources: { known: { decode: simpleDecode } },
  });
  const r = await api(
    req("/api/v1/webhooks/in/missing", { method: "POST", body: "{}" }),
  );
  assertEquals(r.status, 404);
});

Deno.test("non-POST on the path → 405", async () => {
  const { rig } = buildRig();
  const api = webhooksInApi(rig, { sources: { s: { decode: simpleDecode } } });
  const r = await api(req("/api/v1/webhooks/in/s", { method: "GET" }));
  assertEquals(r.status, 405);
  assertEquals(r.headers.get("Allow"), "POST");
});

Deno.test("path outside prefix → 404", async () => {
  const { rig } = buildRig();
  const api = webhooksInApi(rig, { sources: { s: { decode: simpleDecode } } });
  const r = await api(req("/other", { method: "POST", body: "{}" }));
  assertEquals(r.status, 404);
});

Deno.test("verified delivery → 200, outputs reach the rig", async () => {
  const { rig, backend } = buildRig();
  const api = webhooksInApi(rig, {
    sources: {
      s: {
        verify: verify.hmacSha256({ secret: "sec" }),
        decode: simpleDecode,
      },
    },
  });
  const body = JSON.stringify({ id: "7" });
  const sig = `sha256=${await hmacSha256Hex("sec", enc(body))}`;
  const r = await api(req("/api/v1/webhooks/in/s", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-B3nd-Signature": sig },
    body,
  }));
  assertEquals(r.status, 200);
  const results = await r.json();
  assertEquals(results, [{ accepted: true }]);
  assertEquals(backend.seen.length, 1);
  assertEquals(backend.seen[0][0], "mutable://ev/7");
});

Deno.test("bad signature → 401, nothing reaches the rig", async () => {
  const { rig, backend } = buildRig();
  const api = webhooksInApi(rig, {
    sources: {
      s: { verify: verify.hmacSha256({ secret: "sec" }), decode: simpleDecode },
    },
  });
  const r = await api(req("/api/v1/webhooks/in/s", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-B3nd-Signature": "sha256=bad",
    },
    body: JSON.stringify({ id: "7" }),
  }));
  assertEquals(r.status, 401);
  assertEquals(backend.seen.length, 0);
});

Deno.test("malformed payload (decode throws) → 400", async () => {
  const { rig } = buildRig();
  const api = webhooksInApi(rig, { sources: { s: { decode: simpleDecode } } });
  const r = await api(req("/api/v1/webhooks/in/s", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not-json",
  }));
  assertEquals(r.status, 400);
});

Deno.test("fan-out: one delivery → many outputs", async () => {
  const { rig, backend } = buildRig();
  const api = webhooksInApi(rig, {
    sources: {
      batch: {
        decode: decode.json((e) => {
          const ev = e as { ids: string[] };
          return ev.ids.map((id): Output => [`mutable://ev/${id}`, { id }]);
        }),
      },
    },
  });
  const r = await api(req("/api/v1/webhooks/in/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: ["a", "b"] }),
  }));
  assertEquals(r.status, 200);
  assertEquals((await r.json()).length, 2);
  assertEquals(backend.seen.map((o) => o[0]), [
    "mutable://ev/a",
    "mutable://ev/b",
  ]);
});

Deno.test("custom ack shapes the response", async () => {
  const { rig } = buildRig();
  const api = webhooksInApi(rig, {
    sources: { s: { decode: simpleDecode } },
    ack: () => new Response(null, { status: 202 }),
  });
  const r = await api(req("/api/v1/webhooks/in/s", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "1" }),
  }));
  assertEquals(r.status, 202);
});

Deno.test("multiple sources route independently", async () => {
  const { rig, backend } = buildRig();
  const api = webhooksInApi(rig, {
    sources: {
      one: { decode: decode.json(() => [["mutable://one", {}]] as Output[]) },
      two: { decode: decode.json(() => [["mutable://two", {}]] as Output[]) },
    },
  });
  await api(req("/api/v1/webhooks/in/one", { method: "POST", body: "{}" }));
  await api(req("/api/v1/webhooks/in/two", { method: "POST", body: "{}" }));
  assertEquals(backend.seen.map((o) => o[0]), [
    "mutable://one",
    "mutable://two",
  ]);
});
