/// <reference lib="deno.ns" />
/**
 * httpPostContentApi: routing, decoder dispatch, composable helpers.
 */

import { assertEquals } from "@std/assert";
import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  Program,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { httpPostContentApi } from "./service.ts";
import { payloadDecoder as dec } from "./payload-decoder.ts";

/**
 * Stub records every receive call and accepts everything except URIs
 * containing `/__reject__/`. Tests inspect `seen` to confirm the
 * decoder produced the expected payload shape.
 */
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

// deno-lint-ignore require-await
const rejectProgram: Program = async (out) => {
  const [uri] = out;
  if (typeof uri === "string" && uri.includes("/__reject__/")) {
    return { code: "rejected", error: "rejected" };
  }
  return { code: "ok" };
};

function buildRig(): { rig: Rig; backend: StubBackend } {
  const backend = new StubBackend();
  const route = connection(backend, ["**"]);
  return {
    rig: new Rig({
      routes: { receive: [route], read: [route] },
      programs: { "mutable://app": rejectProgram },
    }),
    backend,
  };
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://test${path}`, init);
}

const URI = "mutable://app/x";
const ENCODED = `/api/v1/content/${encodeURIComponent(URI)}`;

Deno.test("non-POST → 405", async () => {
  const { rig } = buildRig();
  const api = httpPostContentApi(rig, { payloadDecoder: dec.json() });
  const r = await api(req(ENCODED, { method: "GET" }));
  assertEquals(r.status, 405);
  assertEquals(r.headers.get("Allow"), "POST");
});

Deno.test("path outside prefix → 404", async () => {
  const { rig } = buildRig();
  const api = httpPostContentApi(rig, { payloadDecoder: dec.json() });
  const r = await api(req("/other", { method: "POST", body: "{}" }));
  assertEquals(r.status, 404);
});

Deno.test("empty URI after prefix → 404", async () => {
  const { rig } = buildRig();
  const api = httpPostContentApi(rig, { payloadDecoder: dec.json() });
  const r = await api(
    req("/api/v1/content/", { method: "POST", body: "{}" }),
  );
  assertEquals(r.status, 404);
});

Deno.test("json() — body parsed and forwarded as payload", async () => {
  const { rig, backend } = buildRig();
  const api = httpPostContentApi(rig, { payloadDecoder: dec.json() });
  const r = await api(req(ENCODED, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "thing" }),
  }));
  assertEquals(r.status, 200);
  const result = await r.json();
  assertEquals(result.accepted, true);
  assertEquals(backend.seen.length, 1);
  assertEquals(backend.seen[0], [URI, { name: "thing" }]);
});

Deno.test("raw() — body becomes Uint8Array payload", async () => {
  const { rig, backend } = buildRig();
  const api = httpPostContentApi(rig, { payloadDecoder: dec.raw() });
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const r = await api(req(ENCODED, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: bytes,
  }));
  assertEquals(r.status, 200);
  const [, payload] = backend.seen[0];
  assertEquals(payload instanceof Uint8Array, true);
  assertEquals(payload as Uint8Array, bytes);
});

Deno.test("intoField — bytes wrapped under named field, contentType kept", async () => {
  const { rig, backend } = buildRig();
  const api = httpPostContentApi(rig, {
    payloadDecoder: dec.intoField("bytes", { keepContentType: true }),
  });
  const bytes = new Uint8Array([1, 2, 3]);
  const r = await api(req(ENCODED, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: bytes,
  }));
  assertEquals(r.status, 200);
  const [, payload] = backend.seen[0];
  const p = payload as { bytes: Uint8Array; contentType: string };
  assertEquals(p.bytes, bytes);
  assertEquals(p.contentType, "image/png");
});

Deno.test("byContentType — dispatch + default fallback", async () => {
  const { rig, backend } = buildRig();
  const api = httpPostContentApi(rig, {
    payloadDecoder: dec.byContentType({
      "application/json": dec.json(),
      "image/*": dec.intoField("bytes", { keepContentType: true }),
      default: dec.raw(),
    }),
  });

  await api(req(ENCODED, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: 1 }),
  }));
  assertEquals(backend.seen[0][1], { ok: 1 });

  await api(req(ENCODED, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: new Uint8Array([7, 7, 7]),
  }));
  const p = backend.seen[1][1] as { bytes: Uint8Array; contentType: string };
  assertEquals(p.contentType, "image/jpeg");

  await api(req(ENCODED, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array([0xff]),
  }));
  assertEquals(backend.seen[2][1] instanceof Uint8Array, true);
});

Deno.test("decoder throws → 400 with the decoder's message", async () => {
  const { rig } = buildRig();
  const api = httpPostContentApi(rig, { payloadDecoder: dec.json() });
  const r = await api(req(ENCODED, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not-json",
  }));
  assertEquals(r.status, 400);
  // The decoder's error reaches the body unwrapped — no envelope,
  // no "payloadDecoder failed:" prefix. JSON parse errors come from
  // the V8 / Deno runtime so the wording isn't ours to assert on
  // exactly; checking it's non-empty plain text is enough.
  const text = await r.text();
  if (text.length === 0) throw new Error("expected non-empty error body");
});

Deno.test("rejected receive → 200 with ReceiveResult { accepted: false }", async () => {
  const { rig } = buildRig();
  const api = httpPostContentApi(rig, { payloadDecoder: dec.json() });
  const rejectedUri = "mutable://app/__reject__/x";
  const r = await api(
    req(`/api/v1/content/${encodeURIComponent(rejectedUri)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
  );
  assertEquals(r.status, 200);
  const result = await r.json();
  assertEquals(result.accepted, false);
});
