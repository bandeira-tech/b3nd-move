# B3nd HTTP Server

Hono-backed HTTP transport for serving a B3nd `Rig`. Plugs into
`createServers()` from `@bandeira-tech/b3nd-core` as a `ServerResolver`.

[GitHub](https://github.com/bandeira-tech/b3nd-servers)

Depends on
[@bandeira-tech/b3nd-core](https://github.com/bandeira-tech/b3nd-core) for
`Rig`, `httpApi`, and the `ServerResolver` contract. Hono is loaded lazily via
dynamic import — it's only fetched when `start()` is called.

> **Deno-only.** This package's `start()` calls `Deno.serve`. JSR is the only
> registry — it isn't dual-published to NPM. **Node consumers**: pull `httpApi`
> from `@bandeira-tech/b3nd-core` directly and feed it to your preferred Node
> HTTP server (Hono on Node, Express, raw `node:http`, Cloudflare Workers,
> etc.). `httpApi(rig)` returns a standard `(Request) => Promise<Response>`
> handler.

## Usage

```typescript
import {
  connection,
  createServers,
  MemoryStore,
  Rig,
  SimpleClient,
} from "@bandeira-tech/b3nd-core";
import { httpServer } from "@bandeira-tech/b3nd-server-http";

const client = new SimpleClient(new MemoryStore());
const rig = new Rig({
  routes: {
    receive: [connection(client, ["*"])],
    read: [connection(client, ["*"])],
  },
});

const servers = createServers(rig, [
  httpServer({ port: 3000, cors: "*" }),
]);
await Promise.all(servers.map((s) => s.start()));
```

## Options

```typescript
httpServer({
  port:     3000,        // default
  hostname: "0.0.0.0",   // default
  cors:     "*",         // optional — falsy disables CORS
  statusMeta: { ... },   // forwarded to httpApi()
});
```

## Development

```bash
deno check src/mod.ts
deno test --allow-all libs/
```

## Related

- [b3nd-core](https://github.com/bandeira-tech/b3nd-core) — framework foundation
- [b3nd-grpc](https://github.com/bandeira-tech/b3nd-grpc) — gRPC client + server
  transport

## License

MIT
