# B3nd Servers

Server-side composition for the B3nd framework. Single package
(`@bandeira-tech/b3nd-servers`) with subpaths for each transport.

[GitHub](https://github.com/bandeira-tech/b3nd-servers)

Depends only on
[`@bandeira-tech/b3nd-core`](https://github.com/bandeira-tech/b3nd-core) for
`Rig`, `httpApi`, and shared types. **No web framework.**

## Subpaths

The package is split so you only pay for what you use, and so non-Deno
runtimes (Node, browsers, Cloudflare Workers, Bun) can pull in the
universal pieces without dragging `Deno.serve` along.

### Universal — published to **JSR + npm**

Runs in browsers, Node, Bun, Deno, Cloudflare Workers — anywhere with
standard `fetch` / `Request` / `Response`.

| Import                                     | Exports                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| `@bandeira-tech/b3nd-servers`              | `createServers`, `ServerResolver`, `TransportServer`, `ServerComposition`, `withCors`, `CorsOptions` |
| `@bandeira-tech/b3nd-servers/grpc/api`     | `grpcApi(rig)` — pure `(Request) => Promise<Response>` handler                    |
| `@bandeira-tech/b3nd-servers/grpc/client`  | `GrpcClient` (Connect-protocol over `fetch`)                                      |
| `@bandeira-tech/b3nd-servers/grpc/proto`   | Wire schema types + JSON converters                                               |

### Deno-only — **JSR only**

These slices call `Deno.serve`. Use them when running on Deno.

| Import                                     | Exports                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| `@bandeira-tech/b3nd-servers/http`         | `httpServer` — wraps `httpApi(rig)` from core with `Deno.serve` + native CORS     |
| `@bandeira-tech/b3nd-servers/grpc/server`  | `grpcServer` (resolver) + `grpcApi` re-exported                                   |
| `@bandeira-tech/b3nd-servers/grpc`         | Bundle: server + client + proto (convenience for Deno apps)                       |

## Usage on Deno

```typescript
import {
  connection,
  MemoryStore,
  Rig,
  SimpleClient,
} from "@bandeira-tech/b3nd-core";
import { createServers } from "@bandeira-tech/b3nd-servers";
import { httpServer } from "@bandeira-tech/b3nd-servers/http";
import { grpcServer } from "@bandeira-tech/b3nd-servers/grpc/server";

const client = new SimpleClient(new MemoryStore());
const rig = new Rig({
  routes: {
    receive: [connection(client, ["*"])],
    read: [connection(client, ["*"])],
  },
});

const servers = createServers(rig, [
  httpServer({ port: 3000 }),
  grpcServer({ port: 50051 }),
], { cors: "*" }); // applies to every transport in this composition

await Promise.all(servers.map((s) => s.start()));
```

CORS can be set per-server (`httpServer({ cors })`, `grpcServer({ cors })`)
or once at the composition level (`createServers(rig, [...], { cors })`).
Per-server wins.

## Usage on Node / browsers

The `httpServer` / `grpcServer` resolvers are Deno-only because `Deno.serve`
doesn't shim. On Node, browsers, Cloudflare Workers, etc., pull the **pure
handlers** from core / this package and feed them to your own HTTP runtime.

### HTTP (handler from core)

```typescript
import { httpApi } from "@bandeira-tech/b3nd-core";
import { withCors } from "@bandeira-tech/b3nd-servers";
import { Hono } from "hono";

const handler = withCors(httpApi(rig), { origin: "*" });

// Node — feed it to Hono / Express / raw node:http
const app = new Hono();
app.all("/api/*", (c) => handler(c.req.raw));

// or in a Cloudflare Worker:
export default { fetch: handler };
```

### gRPC (handler from this package)

```typescript
import { grpcApi } from "@bandeira-tech/b3nd-servers/grpc/api";
import { withCors } from "@bandeira-tech/b3nd-servers";

const handler = withCors(grpcApi(rig), { origin: "*" });
// Same shape — plug into any HTTP runtime.
```

### gRPC client (browser-safe)

```typescript
import { GrpcClient } from "@bandeira-tech/b3nd-servers/grpc/client";

const client = new GrpcClient({ url: "http://localhost:50051" });
const results = await client.read("mutable://app/data");
```

## Wire format (gRPC)

The gRPC subpath speaks the [Connect protocol](https://connectrpc.com/) —
JSON over HTTP/2. Each RPC is a `POST` to `/b3nd.v1.B3ndService/{Method}`
with a JSON body. `Observe` returns newline-delimited JSON. `bytes` fields
are base64-encoded for JSON transport.

| Method  | Path                                         |
| ------- | -------------------------------------------- |
| Receive | `POST /b3nd.v1.B3ndService/Receive`          |
| Read    | `POST /b3nd.v1.B3ndService/Read`             |
| Observe | `POST /b3nd.v1.B3ndService/Observe` (NDJSON) |
| Status  | `POST /b3nd.v1.B3ndService/Status`           |

`b3nd.proto` is shipped on JSR as the canonical schema for external tooling
(`grpcurl`, `buf`, etc.) but no protobuf codegen is required at runtime.

## Project Structure

```
mod.ts                       # ./
grpc.ts                      # ./grpc (Deno-only bundle)
libs/
  b3nd-server-factory/       # createServers + types
  b3nd-cors/                 # withCors
  b3nd-server-http/          # ./http (Deno-only)
  b3nd-server-grpc/
    service.ts               # ./grpc/api (universal)
    mod.ts                   # ./grpc/server (Deno-only)
  b3nd-client-grpc/          # ./grpc/client (universal)
  b3nd-proto/                # ./grpc/proto (universal)
scripts/
  build-npm.ts               # dnt build (universal slice → npm)
```

## Development

```bash
deno task check
deno task test
deno task build:npm   # produces ./npm/ for the universal slice
```

## Related

- [b3nd-core](https://github.com/bandeira-tech/b3nd-core) — framework foundation
- [b3nd-canon](https://github.com/bandeira-tech/b3nd-canon) — protocol-building toolkit

## License

MIT
