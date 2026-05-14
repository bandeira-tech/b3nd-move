# B3nd Move

Encoding, transport, decoding. The moving layer for B3nd.

A B3nd node has two sides facing the wire: a **server** that takes incoming
bytes, decodes them, drives a `Rig` from `@bandeira-tech/b3nd-core`, and
encodes the response — and a **client** that does the inverse from the other
end. `b3nd-move` ships both halves for each supported transport, in one
canonical place, with no re-export indirection between them and your code.

```
   wire bytes  ──►  decode  ──►  Rig (core)  ──►  encode  ──►  wire bytes
       ▲                                                            │
       └───────────── client.ts ◄───────────── server.ts ◄──────────┘
                            (the moving layer)
```

Pick a transport, import the side you need:

| Transport     | Server                       | Client                       | Pure handler                  |
| ------------- | ---------------------------- | ---------------------------- | ----------------------------- |
| HTTP          | `b3nd-move/http/server`      | `b3nd-move/http/client`      | `b3nd-move/http/service`      |
| WebSocket     | `b3nd-move/ws/server`        | `b3nd-move/ws/client`        | `b3nd-move/ws/service`        |
| gRPC-over-HTTP| `b3nd-move/grpc/http/server` | `b3nd-move/grpc/http/client` | `b3nd-move/grpc/http/service` |
| MCP (stdio)   | `b3nd-move/mcp/server`       | —                            | `b3nd-move/mcp/service`       |

Plus the cross-cutting pieces:

| Subpath                       | Exports                                                |
| ----------------------------- | ------------------------------------------------------ |
| `b3nd-move/factory`           | `createServers` + `ServerResolver` / `TransportServer` |
| `b3nd-move/cors`              | `withCors`                                             |
| `b3nd-move/middleware`        | `ClientMiddleware` + canon (`bearer`, `basic`, …)      |
| `b3nd-move/grpc/proto/types`  | generated wire types + schemas + `B3ndService`         |
| `b3nd-move/grpc/proto/convert`| proto ↔ b3nd converters                                |

## The three layers

- **server.ts** — the runtime-bound half. Wraps a `service` handler with
  `Deno.serve` (or stdio for MCP), exposes a `ServerResolver` for
  `createServers`. Deno-only.
- **service.ts** — the portable half. A pure `(Request) => Response` (or
  factory like `buildMcpServer(rig)`). Runs anywhere fetch runs: Node,
  Bun, Cloudflare Workers, browsers as request handlers.
- **client.ts** — a `ProtocolInterfaceNode` over the wire. Works in any
  fetch-capable environment.

Each layer lives in exactly one file. No barrels.

## Quick start (Deno)

```typescript
import { connection, MemoryStore, Rig, SimpleClient } from "@bandeira-tech/b3nd-core";
import { createServers } from "@bandeira-tech/b3nd-move/factory";
import { httpServer } from "@bandeira-tech/b3nd-move/http/server";
import { grpcHttpServer } from "@bandeira-tech/b3nd-move/grpc/http/server";

const store = new SimpleClient(new MemoryStore());
const rig = new Rig({
  routes: {
    receive: [connection(store, ["*"])],
    read: [connection(store, ["*"])],
  },
});

const servers = createServers(rig, [
  httpServer({ port: 3000 }),
  grpcHttpServer({ port: 50051 }),
], { cors: "*" });

await Promise.all(servers.map((s) => s.start()));
```

## Quick start (Node / Bun / Cloudflare)

Use the portable `service` handlers — no `Deno.serve`:

```typescript
import { httpApi } from "@bandeira-tech/b3nd-move/http/service";
import { grpcHttpApi } from "@bandeira-tech/b3nd-move/grpc/http/service";
import { withCors } from "@bandeira-tech/b3nd-move/cors";

const http = withCors(httpApi(rig), { origin: "*" });
const grpc = withCors(grpcHttpApi(rig), { origin: "*" });

// plug into Hono, Express, node:http, a Cloudflare Worker, …
export default { fetch: grpc };
```

## Quick start (client)

```typescript
import { HttpClient } from "@bandeira-tech/b3nd-move/http/client";

const client = new HttpClient({ url: "http://localhost:3000" });
await client.receive([["mutable://app/item", { name: "thing" }]]);
const [out] = await client.read(["mutable://app/item"]);
```

## Auth & client middleware

Every client (`HttpClient`, `WebSocketClient`, `GrpcHttpClient`) accepts the
same `middleware: ClientMiddleware[]` config. Middleware are run at the
right lifecycle phase per transport:

| Hook        | HTTP / gRPC-HTTP        | WebSocket                          |
| ----------- | ----------------------- | ---------------------------------- |
| `onConnect` | —                       | once at handshake (URL, subprotos) |
| `onRequest` | per outbound call       | —                                  |
| `onSend`    | —                       | per outbound frame (envelope)      |

The canon helpers in `b3nd-move/middleware` cover the common cases:

```typescript
import { bearer, basic, apiKey, signEnvelope } from "@bandeira-tech/b3nd-move/middleware";
import { HttpClient } from "@bandeira-tech/b3nd-move/http/client";
import { WebSocketClient } from "@bandeira-tech/b3nd-move/ws/client";
import { GrpcHttpClient } from "@bandeira-tech/b3nd-move/grpc/http/client";

const token = () => tokenStore.get();         // sync or async getter

new HttpClient({     url, middleware: [bearer(token)] });
new WebSocketClient({ url, middleware: [bearer(token)] });
new GrpcHttpClient({ url, middleware: [bearer(token)] });
```

Each canon helper picks the right hook per transport: `bearer()` sets
`Authorization: Bearer …` on HTTP-style calls and falls back to a
`?token=…` query param on the WS handshake (browser `WebSocket` cannot
send headers — use `subprotocol()` if your server reads from
`Sec-WebSocket-Protocol` instead).

Custom middleware is just an object with the hooks you need:

```typescript
import type { ClientMiddleware } from "@bandeira-tech/b3nd-move/middleware";

const stampRequestId: ClientMiddleware = {
  onRequest: (ctx) => { ctx.headers.set("X-Request-ID", crypto.randomUUID()); },
  onSend:    (ctx) => { ctx.envelope.requestId = crypto.randomUUID(); },
};
```

`WebSocketClient`'s legacy `auth: { type, token, … }` config is kept as a
deprecation shim — it's converted to `bearer()` / `basic()` middleware at
construction and will be removed in the next major.

## How rigs compose with transports

Downstream code (CLIs, daemons, browser apps) builds a `Rig` once and aims
it at one or more transports. The same rig serves HTTP, WebSocket, gRPC,
and MCP simultaneously — the move layer is the only thing that varies. A
CLI that wants to serve protocol X over transport Y on encoding Z is
constructed by picking the right rig and the right `b3nd-move` resolvers.

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
