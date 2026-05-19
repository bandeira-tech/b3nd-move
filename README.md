# B3nd Move

Encoding, transport, decoding. The moving layer for B3nd.

A B3nd node has two sides facing the wire: a **service** that takes incoming
bytes, decodes them, drives a `Rig` from `@bandeira-tech/b3nd-core`, and encodes
the response — and a **client** that does the inverse from the other end.
`b3nd-move` ships both halves for each supported transport, in one canonical
place, with no re-export indirection between them and your code.

```
wire bytes  ──►  decode  ──►  Rig (core)  ──►  encode  ──►  wire bytes
    ▲                                                            │
    └───────────── client.ts ◄───────────── service.ts ◄─────────┘
                         (the moving layer)
```

Pick a transport, import the side you need:

| Transport        | Client                       | Pure handler                         |
| ---------------- | ---------------------------- | ------------------------------------ |
| HTTP             | `b3nd-move/http/client`      | `b3nd-move/http/service`             |
| WebSocket        | `b3nd-move/ws/client`        | `b3nd-move/ws/service`               |
| gRPC-over-HTTP   | `b3nd-move/grpc/http/client` | `b3nd-move/grpc/http/service`        |
| MCP (stdio)      | —                            | `b3nd-move/mcp/service`              |
| HTTP GET content | —                            | `b3nd-move/http-get-content/service` |

The last row is a **specialized facet**, not a full transport — a locked-surface
request frontend for a narrower job (single-URI GET read with host-controlled
response shape, for browsers / CDNs / `<img src>`). See
[`src/http-get-content/`](./src/http-get-content/).

Plus the proto pieces:

| Subpath                        | Exports                                        |
| ------------------------------ | ---------------------------------------------- |
| `b3nd-move/grpc/proto/types`   | generated wire types + schemas + `B3ndService` |
| `b3nd-move/grpc/proto/convert` | proto ↔ b3nd converters                        |

## The two layers

- **service.ts** — the portable half. A pure `(Request) => Response` (or factory
  like `buildMcpServer(rig)`). Runs anywhere fetch runs: Deno, Node, Bun,
  Cloudflare Workers, browsers as request handlers.
- **client.ts** — a `ProtocolInterfaceNode` over the wire. Works in any
  fetch-capable environment.

Each layer lives in exactly one file. No barrels. Runtime binding (`Deno.serve`,
stdio, framework adapters) is **not** in this package — pair a `service` handler
with whatever your host runtime offers, or use a higher-level SDK / runner that
wraps it. For local dev this repo ships `dev/serve.ts` plus a `deno task serve`
wrapper; see [Local dev](#local-dev-serve-task).

## Quick start (any runtime)

```typescript
import { connection, Rig } from "@bandeira-tech/b3nd-core";
import { httpApi } from "@bandeira-tech/b3nd-move/http/service";
import { grpcHttpApi } from "@bandeira-tech/b3nd-move/grpc/http/service";

// Bring your own backend implementing `ProtocolInterfaceNode`
// (b3nd-save, a custom node, etc.). Anything with `receive`/`read`/
// `observe`/`status` plugs in here.
const backend = /* your ProtocolInterfaceNode */;
const rig = new Rig({
  routes: {
    receive: [connection(backend, ["*"])],
    read: [connection(backend, ["*"])],
  },
});

// Deno
Deno.serve({ port: 3000 }, httpApi(rig));

// Cloudflare Workers / Bun
export default { fetch: grpcHttpApi(rig) };

// Node — pair with @hono/node-server, express, node:http, …
// Add CORS / auth / etc. with whatever middleware your runtime offers.
```

## Local dev (`serve` task)

For ad-hoc local runs there's a tiny in-repo helper that builds a
`stubRig`-backed runner (canned echo semantics) and starts the requested
transports:

```bash
deno task serve -- --http               # http on :3000
deno task serve -- --http=4000 --ws     # http on :4000, ws on :8080
deno task serve -- --grpc=50051 --hostname=127.0.0.1
deno task serve -- --mcp                # MCP on stdio (must be alone)
```

The helper lives at [`dev/serve.ts`](./dev/serve.ts) and is intentionally
outside `src/`. Production runners and SDKs build their own equivalents tuned to
their host runtime; this is just so contributors and demos have one obvious spot
to reach for.

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
