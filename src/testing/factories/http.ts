/**
 * @module
 * In-process HTTP factory — boots `httpApi(rig)` via `Deno.serve` on
 * an ephemeral port and returns an `HttpClient` pointing at it. Used
 * by the PIN contract suite.
 */

import { httpApi } from "../../http/service.ts";
import { HttpClient } from "../../http/client.ts";
import type { ServerFactory } from "../contract.ts";
import { defaultRig } from "./_rig.ts";

/**
 * Boot `httpApi(rig)` on a free port and return an `HttpClient` for it.
 * The factory is self-contained — caller doesn't pick a port, doesn't
 * see the rig.
 */
export const httpInProcess: ServerFactory = () => {
  const rig = defaultRig();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    httpApi(rig),
  );
  const { port } = server.addr as Deno.NetAddr;
  const client = new HttpClient({ url: `http://127.0.0.1:${port}` });
  return Promise.resolve({
    client,
    cleanup: () => server.shutdown(),
  });
};
