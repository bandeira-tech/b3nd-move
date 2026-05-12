/**
 * @module
 * B3nd Servers — server-side composition for the B3nd framework.
 *
 * The root subpath exports composition primitives:
 *   • `createServers(rig, resolvers, composition?)` — wires resolvers into a rig
 *   • `ServerResolver`, `TransportServer`, `ServerComposition` — the contract
 *   • `withCors(handler, opts)` — shared CORS middleware
 *
 * Concrete transports live in subpaths:
 *   • `./http`           — `httpServer` (Deno.serve + native CORS)
 *   • `./grpc/http`      — `grpcHttpServer`, `grpcHttpApi`, `GrpcHttpClient`, proto schema
 *
 * `httpApi(rig)` (the pure HTTP request handler) lives in
 * `@bandeira-tech/b3nd-core` — pull it from there if you want to embed
 * the rig in your own HTTP runtime without this package.
 */

export { createServers } from "./libs/b3nd-server-factory/mod.ts";
export type {
  ServerComposition,
  ServerResolver,
  TransportServer,
} from "./libs/b3nd-server-factory/mod.ts";

export { withCors } from "./libs/b3nd-cors/mod.ts";
export type { CorsOptions } from "./libs/b3nd-cors/mod.ts";
