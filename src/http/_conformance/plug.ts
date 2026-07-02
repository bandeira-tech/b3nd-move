/**
 * HTTP transport plug.
 *
 * The single source of truth for how the HTTP transport boots and how a
 * client is built against it. Consumed by:
 *   - `src/http/conformance.test.ts`      — in-Deno run via `runMovePlug`
 *   - `tests/integration/browser/http.test.ts` — server boot for the
 *     browser run (with `cors: true`)
 *
 * Publish-excluded (see `deno.json`): this is test support, not shipped
 * code, so the `Deno.serve` binding lives here rather than in `src/`
 * proper without violating "runtime binding lives outside the package".
 */

/// <reference lib="deno.ns" />

import type { ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core/types";
import type {
  MovePlug,
  ServerHandle,
  StartOpts,
} from "../../../tests/suites/move-plug.ts";
import { httpApi } from "../service.ts";
import { HttpClient } from "../client.ts";
import { withCors } from "../../cors.ts";
import { httpOutputsFrame } from "../../codecs/http/mod.ts";

const codec = httpOutputsFrame();
const enc = new TextEncoder();

export const httpPlug: MovePlug = {
  name: "http",
  startServer: (pin: ProtocolInterfaceNode, opts?: StartOpts): ServerHandle => {
    const api = httpApi(pin, { codec });
    const handler = opts?.cors ? withCors(api, { origin: "*" }) : api;
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      handler,
    );
    const { port } = server.addr as Deno.NetAddr;
    return { url: `http://127.0.0.1:${port}`, stop: () => server.shutdown() };
  },
  // HTTP wire is opaque bytes past the URL — encode JS payloads once at
  // the producer's edge. The stub pin ignores payload content; this is
  // purely for what the wire requires.
  makeClient: (url) => new HttpClient({ url, codec }),
  payload: (v) => enc.encode(JSON.stringify(v)),
};
