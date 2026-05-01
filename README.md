# B3nd Servers

Server-side composition for the B3nd framework. One package,
subpaths for each transport — only pay for what you use.

## Subpaths

| Subpath | Exports | Runtime |
|---|---|---|
| `.` | `createServers`, `withCors` + types | any |
| `./http` | `httpServer` — `Deno.serve` + CORS | Deno |
| `./grpc/http` | `grpcHttpServer`, `grpcHttpApi`, `GrpcHttpClient` + proto (umbrella) | Deno (server) / any (api + client) |
| `./grpc/http/api` | `grpcHttpApi(rig)` — pure fetch handler | any |
| `./grpc/http/server` | `grpcHttpServer` resolver | Deno |
| `./grpc/http/client` | `GrpcHttpClient` | any |
| `./grpc/proto` | wire types, schemas, converters, `B3ndService` descriptor | any |
| `./mcp` | `mcpServer`, `buildMcpServer` (umbrella) | Deno (server) / any (api) |
| `./mcp/server` | `mcpServer` resolver — stdio transport | Deno |
| `./mcp/api` | `buildMcpServer(rig)` — bare MCP Server instance | any |

Details in each lib's README (under `libs/`).

## Quick start (Deno)

```typescript
import { Rig, connection, MemoryStore, SimpleClient } from "@bandeira-tech/b3nd-core";
import { createServers } from "@bandeira-tech/b3nd-servers";
import { httpServer } from "@bandeira-tech/b3nd-servers/http";
import { grpcHttpServer } from "@bandeira-tech/b3nd-servers/grpc/http/server";

const store = new SimpleClient(new MemoryStore());
const rig = new Rig({ routes: { receive: [connection(store, ["*"])], read: [connection(store, ["*"])] } });

const servers = createServers(rig, [
  httpServer({ port: 3000 }),
  grpcHttpServer({ port: 50051 }),
], { cors: "*" });

await Promise.all(servers.map((s) => s.start()));
```

## Quick start (Node / Cloudflare / Bun)

Use the pure fetch handlers — no `Deno.serve` involved:

```typescript
import { httpApi } from "@bandeira-tech/b3nd-core";
import { withCors } from "@bandeira-tech/b3nd-servers";
import { grpcHttpApi } from "@bandeira-tech/b3nd-servers/grpc/http/api";

const http  = withCors(httpApi(rig),     { origin: "*" });
const grpc  = withCors(grpcHttpApi(rig), { origin: "*" });

// plug either into Hono, Express, raw node:http, or a Cloudflare Worker
export default { fetch: grpc };
```

## Development

```bash
deno task check
deno task test
deno task build:npm   # universal slice → ./npm/
```

## Related

- [b3nd-core](https://github.com/bandeira-tech/b3nd-core) — `Rig`, `httpApi`, shared types
- [b3nd-canon](https://github.com/bandeira-tech/b3nd-canon) — protocol-building toolkit

## License

MIT
