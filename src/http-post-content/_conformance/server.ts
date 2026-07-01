/**
 * POST-content facet test server.
 *
 * Content transports are NOT PIN-symmetric, so they do not plug into the
 * shared `runMoveSuite`. This is their own co-located server boot:
 * `httpPostContentApi` over a bespoke rig that accepts everything except
 * `/__reject__/` URIs (rejected at the program stage), wrapped in
 * `withCors`. `seen` accumulates what the rig forwarded to the backend so
 * the browser harness can verify decoder behavior via a `GET /__seen`
 * peek endpoint this server adds.
 *
 * Publish-excluded test support (see `deno.json`).
 */

/// <reference lib="deno.ns" />

import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  Program,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import type { ServerHandle } from "../../../tests/suites/move-plug.ts";
import { httpPostContentApi } from "../service.ts";
import { payloadDecoder as dec } from "../payload-decoder.ts";
import { withCors } from "../../cors.ts";

class ContentPostStubBackend implements ProtocolInterfaceNode {
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

export function startHttpPostContentServer(): Promise<ServerHandle> {
  const backend = new ContentPostStubBackend();
  const route = connection(backend, ["**"]);
  const rig = new Rig({
    routes: { receive: [route], read: [route] },
    programs: { "mutable://t": rejectProgram },
  });

  const api = httpPostContentApi(rig, {
    payloadDecoder: dec.byContentType({
      "application/json": dec.json(),
      "text/plain": dec.text(),
      "image/*": dec.intoField("bytes", { keepContentType: true }),
      default: dec.raw(),
    }),
  });

  // The browser harness pokes /__seen to read back what the backend
  // received; cors wraps both routes.
  const handler = withCors(async (req: Request) => {
    if (new URL(req.url).pathname === "/__seen") {
      // Uint8Array doesn't JSON-serialize meaningfully — fold to byte
      // arrays so the browser can assertEquals on them.
      const flat = backend.seen.map(([uri, payload]) => [
        uri,
        serializableCopy(payload),
      ]);
      return new Response(JSON.stringify(flat), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return await api(req);
  }, { origin: "*" });

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

function serializableCopy(v: unknown): unknown {
  if (v instanceof Uint8Array) return Array.from(v);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = serializableCopy(val);
    return out;
  }
  return v;
}
