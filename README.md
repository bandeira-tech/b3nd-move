# B3nd Move

Encoding, transport, decoding. The moving layer for B3nd.

A B3nd node has two sides facing the wire: a **server** that takes incoming
bytes, decodes them, drives a `Rig` from `@bandeira-tech/b3nd-core`, and encodes
the response — and a **client** that does the inverse from the other end.
`b3nd-move` ships both halves for each supported transport, in one canonical
place, with no re-export indirection between them and your code.

```
wire bytes  ──►  decode  ──►  Rig (core)  ──►  encode  ──►  wire bytes
    ▲                                                            │
    └───────────── client.ts ◄───────────── server.ts ◄──────────┘
                         (the moving layer)
```

Pick a transport, import the side you need:

| Transport      | Server                       | Client                       | Pure handler                  |
| -------------- | ---------------------------- | ---------------------------- | ----------------------------- |
| HTTP           | `b3nd-move/http/server`      | `b3nd-move/http/client`      | `b3nd-move/http/service`      |
| WebSocket      | `b3nd-move/ws/server`        | `b3nd-move/ws/client`        | `b3nd-move/ws/service`        |
| gRPC-over-HTTP | `b3nd-move/grpc/http/server` | `b3nd-move/grpc/http/client` | `b3nd-move/grpc/http/service` |
| MCP (stdio)    | `b3nd-move/mcp/server`       | —                            | `b3nd-move/mcp/service`       |

Plus the proto pieces:

| Subpath                        | Exports                                        |
| ------------------------------ | ---------------------------------------------- |
| `b3nd-move/grpc/proto/types`   | generated wire types + schemas + `B3ndService` |
| `b3nd-move/grpc/proto/convert` | proto ↔ b3nd converters                        |

## The three layers

- **server.ts** — the runtime-bound half. A direct `transport(rig, opts?)`
  function that wraps a `service` handler with `Deno.serve` (or stdio for MCP)
  and returns a `start`/`stop` `TransportServer`. Deno-only.
- **service.ts** — the portable half. A pure `(Request) => Response` (or factory
  like `buildMcpServer(rig)`). Runs anywhere fetch runs: Node, Bun, Cloudflare
  Workers, browsers as request handlers.
- **client.ts** — a `ProtocolInterfaceNode` over the wire. Works in any
  fetch-capable environment.

Each layer lives in exactly one file. No barrels. Cross-cutting concerns (CORS,
multi-server composition, etc.) are intentionally not part of this package —
wrap a `service` handler yourself, or reach for a higher-level SDK that bundles
the conveniences.

## Quick start (Deno)

```typescript
import {
  connection,
  MemoryStore,
  Rig,
  SimpleClient,
} from "@bandeira-tech/b3nd-core";
import { httpServer } from "@bandeira-tech/b3nd-move/http/server";
import { grpcHttpServer } from "@bandeira-tech/b3nd-move/grpc/http/server";

const store = new SimpleClient(new MemoryStore());
const rig = new Rig({
  routes: {
    receive: [connection(store, ["*"])],
    read: [connection(store, ["*"])],
  },
});

const servers = [
  httpServer(rig, { port: 3000 }),
  grpcHttpServer(rig, { port: 50051 }),
];

await Promise.all(servers.map((s) => s.start()));
```

## Quick start (Node / Bun / Cloudflare)

Use the portable `service` handlers — no `Deno.serve`:

```typescript
import { httpApi } from "@bandeira-tech/b3nd-move/http/service";
import { grpcHttpApi } from "@bandeira-tech/b3nd-move/grpc/http/service";

// Plug into Hono, Express, node:http, a Cloudflare Worker, …
// Add CORS / auth / etc. with whatever middleware your runtime uses.
export default { fetch: grpcHttpApi(rig) };
```

## Quick start (client)

```typescript
import { HttpClient } from "@bandeira-tech/b3nd-move/http/client";

const client = new HttpClient({ url: "http://localhost:3000" });
await client.receive([["mutable://app/item", { name: "thing" }]]);
const [out] = await client.read(["mutable://app/item"]);
```

## Auth & pre-send hooks

Every client takes a single `preSend` function — there is no middleware
abstraction. Compose behaviors with plain function calls.

```typescript
import { HttpClient } from "@bandeira-tech/b3nd-move/http/client";
import { WebSocketClient } from "@bandeira-tech/b3nd-move/ws/client";
import { GrpcHttpClient } from "@bandeira-tech/b3nd-move/grpc/http/client";

new HttpClient({
  url,
  preSend: (r) =>
    r.headers.set("Authorization", `Bearer ${await tokens.get()}`),
});

new GrpcHttpClient({
  url,
  preSend: (r) =>
    r.headers.set("Authorization", `Bearer ${await tokens.get()}`),
});

// WebSocket: preSend runs per frame. Handshake auth goes in the URL —
// pass a function if it needs to be computed fresh per (re)connect.
new WebSocketClient({
  url: async () => `wss://node?token=${await tokens.get()}`,
  preSend: (env) => {
    env.requestId = crypto.randomUUID();
  },
});
```

The hook shape per client:

| Client            | `preSend` argument                                       |
| ----------------- | -------------------------------------------------------- |
| `HttpClient`      | `{ url: URL, headers: Headers, body: BodyInit \| null }` |
| `GrpcHttpClient`  | `{ url: URL, headers: Headers, body: BodyInit \| null }` |
| `WebSocketClient` | `envelope: Record<string, unknown>` (mutated in place)   |

Composition is just function composition — no framework needed:

```typescript
const auth = (r) => r.headers.set("Authorization", `Bearer ${getToken()}`);
const trace = (r) => r.headers.set("X-Trace", crypto.randomUUID());

new HttpClient({
  url,
  preSend: async (r) => {
    await auth(r);
    trace(r);
  },
});
```

Browser `WebSocket` cannot send custom headers, which is why WS auth goes in the
handshake URL or subprotocols — build the URL with the credentials you want
before opening the socket.

## How rigs compose with transports

Downstream code (CLIs, daemons, browser apps) builds a `Rig` once and aims it at
one or more transports. The same rig serves HTTP, WebSocket, gRPC, and MCP
simultaneously — the move layer is the only thing that varies. A CLI that wants
to serve protocol X over transport Y on encoding Z is constructed by picking the
right rig and the right `b3nd-move` transports.

## Development

```bash
deno task check
deno task test
deno task build:npm   # universal slices → ./npm/
```

## Related

- [b3nd-core](https://github.com/bandeira-tech/b3nd-core) — `Rig`,
  `ProtocolInterfaceNode`, shared types
- [b3nd-canon](https://github.com/bandeira-tech/b3nd-canon) — protocol-building
  toolkit

## License

MIT
