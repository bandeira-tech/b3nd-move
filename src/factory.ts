/**
 * @module
 * Server factory — composable transport layer for the rig.
 *
 * Mirrors the `BackendResolver` pattern for storage:
 *   BackendResolver  → maps URL → Store (storage side)
 *   ServerResolver   → maps Rig → TransportServer (serving side)
 *
 * Each transport (HTTP, gRPC, WebSocket, …) implements `ServerResolver`.
 * `createServers()` wires them all up:
 *
 * @example
 * ```typescript
 * import { createServers } from "@bandeira-tech/b3nd-move/factory";
 * import { httpServer } from "@bandeira-tech/b3nd-move/http/server";
 * import { grpcHttpServer } from "@bandeira-tech/b3nd-move/grpc/http/server";
 *
 * const servers = createServers(rig, [
 *   httpServer({ port: 3000 }),
 *   grpcHttpServer({ port: 50051 }),
 * ], { cors: "*" });
 * await Promise.all(servers.map(s => s.start()));
 * ```
 */

import type { Rig } from "@bandeira-tech/b3nd-core";

/**
 * A running transport server — lifecycle + identity.
 *
 * Created by a `ServerResolver`. Start/stop control the underlying
 * listener (Deno.serve, net.listen, etc.).
 */
export interface TransportServer {
  /** Transport name: "http", "grpc", "ws", etc. */
  readonly transport: string;
  /** Listening address, e.g. "http://0.0.0.0:3000" */
  readonly address: string;
  /** Start accepting connections. */
  start(): Promise<void>;
  /** Graceful shutdown. */
  stop(): Promise<void>;
}

/**
 * Composition-level options shared across all transports in a
 * `createServers([...])` group.
 *
 * Resolvers honor whatever they understand and ignore the rest. A
 * per-resolver option of the same name (e.g. `httpServer({ cors })`)
 * always wins over the composition default.
 */
export interface ServerComposition {
  /**
   * CORS origin applied to every HTTP-speaking transport. Use `"*"`
   * for any origin; falsy disables CORS. Per-resolver `cors` overrides.
   */
  cors?: string;
}

/**
 * Factory that creates a TransportServer for a given rig.
 *
 * Implement one per transport. The resolver holds per-server config
 * (port, hostname, TLS, etc.); composition-level config (CORS) flows
 * through `create()`'s second argument.
 */
export interface ServerResolver {
  /** Transport name — matches `TransportServer.transport`. */
  transport: string;
  /** Create a server bound to the given rig. */
  create(rig: Rig, composition?: ServerComposition): TransportServer;
}

/**
 * Create TransportServer instances from resolvers.
 *
 * Does not start them — call `.start()` on each (or `Promise.all`).
 * The optional `composition` argument applies cross-cutting concerns
 * (CORS, …) to every resolver in one shot.
 */
export function createServers(
  rig: Rig,
  resolvers: ServerResolver[],
  composition?: ServerComposition,
): TransportServer[] {
  return resolvers.map((r) => r.create(rig, composition));
}
