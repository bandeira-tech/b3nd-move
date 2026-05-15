# src

The moving layer for B3nd. Each transport directory follows the same three-file
convention; the two files at this level are the cross-cutting infrastructure
that every transport plugs into.

## Convention

```
src/<transport>/
  server.ts   ← runtime-bound resolver (Deno.serve, stdio, …)
  service.ts  ← portable handler (works in any fetch / SDK runtime)
  client.ts   ← ProtocolInterfaceNode over the wire
```

`server.ts` wraps `service.ts` with a listener (and CORS). `client.ts` speaks
the wire shape `service.ts` exposes. Every transport's surface collapses to
these three files. No barrels — import from the canonical file directly.

## Cross-cutting surface

| File         | Exports                                                                   | Runtime |
| ------------ | ------------------------------------------------------------------------- | ------- |
| `factory.ts` | `createServers`, `ServerResolver`, `TransportServer`, `ServerComposition` | any     |
| `cors.ts`    | `withCors`, `CorsOptions`                                                 | any     |

## Concepts

**`ServerResolver`** is the contract every transport's `server.ts` implements:
`(Rig, ServerComposition?) → TransportServer`. It mirrors `BackendResolver` on
the storage side:

```
BackendResolver  : URL  → Store           (storage)
ServerResolver   : Rig  → TransportServer (moving)
```

**`createServers`** doesn't start anything — it just maps resolvers over a rig.
Lifecycle (`start` / `stop`) is per-server.

**`ServerComposition`** flows cross-cutting concerns (currently just `cors`)
into every resolver in the group. Per-server options win over composition
defaults.

## Usage

```typescript
import { createServers } from "@bandeira-tech/b3nd-move/factory";
import { httpServer } from "@bandeira-tech/b3nd-move/http/server";
import { wsServer } from "@bandeira-tech/b3nd-move/ws/server";

const servers = createServers(rig, [
  httpServer({ port: 3000 }),
  wsServer({ port: 8080 }),
], { cors: "*" });

await Promise.all(servers.map((s) => s.start()));
```

For runtimes without `Deno.serve` (Node, Bun, Cloudflare), skip the resolvers
and wrap the portable `service` directly:

```typescript
import { httpApi } from "@bandeira-tech/b3nd-move/http/service";
import { withCors } from "@bandeira-tech/b3nd-move/cors";

export default { fetch: withCors(httpApi(rig), { origin: "*" }) };
```

## Per-transport docs

- [`http/`](./http/README.md) — HTTP + NDJSON observe
- [`ws/`](./ws/README.md) — WebSocket framing
- [`grpc/http/`](./grpc/http/README.md) — gRPC-over-HTTP (JSON + binary)
- [`grpc/proto/`](./grpc/proto/README.md) — generated wire types + converters
- [`mcp/`](./mcp/README.md) — Model Context Protocol (stdio)
- [`testing/`](./testing/README.md) — PIN contract + MCP spec harness
