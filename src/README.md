# src

The moving layer for B3nd. Each transport directory follows the same three-file
convention.

## Convention

```
src/<transport>/
  server.ts   ← runtime-bound (Deno.serve, stdio, …)
  service.ts  ← portable handler (works in any fetch / SDK runtime)
  client.ts   ← ProtocolInterfaceNode over the wire
```

`server.ts` is a thin Deno-bound wrapper around `service.ts`. `client.ts` speaks
the wire shape `service.ts` exposes. Every transport's surface collapses to
these three files plus optional helpers (e.g. `http/sse.ts`). No barrels —
import from the canonical file directly.

## Concepts

**`TransportServer`** is the lifecycle shape every `server.ts` returns:

```typescript
interface TransportServer {
  readonly transport: string;
  readonly address: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

Each `server.ts` exports a single function — `httpServer(rig, opts?)`,
`wsServer(rig, opts?)`, etc. — that constructs and returns a `TransportServer`.
There is no shared factory or composition layer; if you want to spin up several
transports together, call them in a loop.

**Cross-cutting concerns are out of scope.** CORS, auth wrappers, multi-server
orchestration — none of it lives here. Wrap the portable `service` handlers
yourself, or reach for a higher-level SDK. The move layer exists to do encoding
/ transport / decoding and nothing else.

## Usage

```typescript
import { httpServer } from "@bandeira-tech/b3nd-move/http/server";
import { wsServer } from "@bandeira-tech/b3nd-move/ws/server";

const servers = [
  httpServer(rig, { port: 3000 }),
  wsServer(rig, { port: 8080 }),
];

await Promise.all(servers.map((s) => s.start()));
```

For runtimes without `Deno.serve` (Node, Bun, Cloudflare), skip `server.ts`
entirely and wrap the portable `service` handler directly:

```typescript
import { httpApi } from "@bandeira-tech/b3nd-move/http/service";

// Add CORS / auth / etc. with your runtime's own middleware.
export default { fetch: httpApi(rig) };
```

## Per-transport docs

- [`http/`](./http/README.md) — HTTP + SSE
- [`ws/`](./ws/README.md) — WebSocket framing
- [`grpc/http/`](./grpc/http/README.md) — gRPC-over-HTTP (JSON + binary)
- [`grpc/proto/`](./grpc/proto/README.md) — generated wire types + converters
- [`mcp/`](./mcp/README.md) — Model Context Protocol (stdio)
