/**
 * `MovePlug` — the transport plug contract for `runMoveSuite`.
 *
 * A transport proves it moves the PIN surface faithfully by describing
 * itself as a plug: how to boot its server around a rig, how to build a
 * client against the resulting URL, and (where the wire needs it) how to
 * adapt a JS payload into the wire's shape. `runMovePlug` owns the whole
 * in-Deno lifecycle — build `stubRig`, start the server, drive every
 * shared expectation through the client, tear the server down — so a
 * transport's conformance run collapses to a single call co-located with
 * its code:
 *
 *     import { runMovePlug } from "../../tests/suites/move-plug.ts";
 *     await runMovePlug(httpPlug);
 *
 * This runner boots a real `Deno.serve` loopback server, so it is
 * Deno-only and lives apart from `move-suite.ts` (which stays browser-safe
 * for the bundled browser harnesses).
 */

/// <reference lib="deno.ns" />

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import type { ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core/types";
import { runMoveSuite } from "./move-suite.ts";
import { stubRig } from "../rigs/stub.ts";

/** A booted transport server the suite can point a client at. */
export interface ServerHandle {
  /** Base URL the client should point at. */
  url: string;
  /** Tear down the server. */
  stop: () => Promise<void> | void;
}

/**
 * Options for booting a plug's server. The in-Deno conformance run needs
 * nothing (same-origin, no browser); the browser driver passes
 * `{ cors: true }` so a cross-origin browser client can reach it.
 */
export interface StartOpts {
  cors?: boolean;
}

/**
 * Everything the shared move suite needs to exercise one transport over a
 * real loopback wire. One plug = one server + one client config = one
 * conformance run; codec variants (e.g. gRPC JSON vs binary) are separate
 * plugs.
 */
export interface MovePlug {
  /** Suite label; prefixes every test name. */
  name: string;
  /** Boot the transport server around the given rig. */
  startServer: (
    rig: Rig,
    opts?: StartOpts,
  ) => Promise<ServerHandle> | ServerHandle;
  /** Build a fresh client pointed at the booted server's URL. */
  makeClient: (
    url: string,
  ) => ProtocolInterfaceNode | Promise<ProtocolInterfaceNode>;
  /**
   * Adapt a JS-value payload into what this transport's `receive` wire
   * accepts. HTTP is opaque bytes past the URL — pass
   * `(v) => new TextEncoder().encode(JSON.stringify(v))`. WS and gRPC
   * serialize inside their own envelopes — leave undefined (identity).
   */
  payload?: (value: unknown) => unknown;
  /** Set false for transports without observe. Default true. */
  supportsObserve?: boolean;
}

/**
 * Boot the plug's server against `stubRig`, register the shared move
 * suite against a client pointed at it, and register a teardown test that
 * shuts the server down after the suite's tests have run.
 */
export async function runMovePlug(plug: MovePlug): Promise<void> {
  const server = await plug.startServer(stubRig());
  runMoveSuite(plug.name, {
    client: () => plug.makeClient(server.url),
    payload: plug.payload,
    supportsObserve: plug.supportsObserve,
  });
  Deno.test({
    name: `[${plug.name}] teardown`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => server.stop(),
  });
}
