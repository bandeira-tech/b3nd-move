# b3nd-server-factory

`createServers` and the `ServerResolver` / `TransportServer` contract.

## API

### `createServers(rig, resolvers, composition?)`

Calls `resolver.create(rig, composition)` for each resolver and returns the
resulting `TransportServer[]`. Does not start them.

```typescript
import { createServers } from "@bandeira-tech/b3nd-servers";
import { httpServer } from "@bandeira-tech/b3nd-servers/http";
import { grpcHttpServer } from "@bandeira-tech/b3nd-servers/grpc/http/server";

const servers = createServers(rig, [
  httpServer({ port: 3000 }),
  grpcHttpServer({ port: 50051 }),
], { cors: "*" });

await Promise.all(servers.map((s) => s.start()));
// later:
await Promise.all(servers.map((s) => s.stop()));
```

### `ServerResolver`

```typescript
interface ServerResolver {
  transport: string;
  create(rig: Rig, composition?: ServerComposition): TransportServer;
}
```

Implement this to add a new transport. Hold per-server config (port, TLS, etc.)
in the resolver; cross-cutting config (CORS) flows through `composition`.

### `TransportServer`

```typescript
interface TransportServer {
  readonly transport: string; // "http" | "grpc-http" | "mcp" | …
  readonly address: string; // "http://0.0.0.0:3000" | "stdio" | …
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

### `ServerComposition`

```typescript
interface ServerComposition {
  cors?: string; // CORS origin applied to all HTTP-speaking transports
}
```
