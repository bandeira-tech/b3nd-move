/**
 * @module
 * b3nd-testing — shared integration-test harness for B3nd transports.
 *
 * Currently exports the **PIN contract** — a fixed suite of `Deno.test`s
 * exercising the framework invariants of `ProtocolInterfaceNode`
 * (receive/read/status) over the network boundary. Each transport
 * supplies a `ServerFactory` that boots a rig + transport in-process and
 * returns a connected client; the contract runs identically against all
 * of them.
 *
 * This lib is publish-excluded — it lives in the workspace to test the
 * transports we ship, not to be consumed externally.
 */

export { pinContract } from "./contract.ts";
export type { ServerFactory } from "./contract.ts";
