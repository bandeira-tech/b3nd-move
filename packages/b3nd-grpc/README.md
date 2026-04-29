# B3nd gRPC

gRPC client + server for B3nd, speaking the Connect protocol (JSON over HTTP/2).
No protobuf codegen required at runtime — the wire schema is hand-written
TypeScript, and `b3nd.proto` is shipped as the canonical schema for external
tooling (grpcurl, buf, etc.).

[GitHub](https://github.com/bandeira-tech/b3nd-grpc)

Depends on
[@bandeira-tech/b3nd-core](https://github.com/bandeira-tech/b3nd-core) for
`Rig`, `ProtocolInterfaceNode`, and the wire-adjacent types.

## Server

```typescript
import {
  connection,
  createServers,
  MemoryStore,
  Rig,
  SimpleClient,
} from "@bandeira-tech/b3nd-core";
import { grpcServer } from "@bandeira-tech/b3nd-grpc/server";

const client = new SimpleClient(new MemoryStore());
const rig = new Rig({
  routes: {
    receive: [connection(client, ["*"])],
    read: [connection(client, ["*"])],
  },
});

const servers = createServers(rig, [grpcServer({ port: 50051 })]);
await Promise.all(servers.map((s) => s.start()));
```

## Client

```typescript
import { GrpcClient } from "@bandeira-tech/b3nd-grpc/client";

const client = new GrpcClient({ url: "http://localhost:50051" });
const results = await client.read("mutable://app/data");
```

## Registering the `grpc://` protocol

`@bandeira-tech/b3nd-core`'s backend factory does not include `grpc://` as a
built-in. Register it as a backend resolver if you want
`createClientFromUrl("grpc://host:port")` support:

```typescript
import { createClientFromUrl } from "@bandeira-tech/b3nd-core";
import { GrpcClient } from "@bandeira-tech/b3nd-grpc/client";

const client = await createClientFromUrl("http://localhost:50051", {
  // grpc:// is just http:// over Connect; pass the http URL directly,
  // or instantiate GrpcClient yourself.
});

// Or simply:
const grpc = new GrpcClient({ url: "http://localhost:50051" });
```

## Subpath Exports

```typescript
import { ... } from "@bandeira-tech/b3nd-grpc";          // everything
import { ... } from "@bandeira-tech/b3nd-grpc/client";   // GrpcClient
import { ... } from "@bandeira-tech/b3nd-grpc/server";   // grpcServer
import { ... } from "@bandeira-tech/b3nd-grpc/proto";    // wire schema + converters
```

## Wire Format

The transport is the [Connect protocol](https://connectrpc.com/) — JSON over
HTTP/2. Each RPC is a `POST` to `/b3nd.v1.B3ndService/{Method}` with a JSON
body. `Observe` returns newline-delimited JSON.

`bytes` fields are base64-encoded for JSON transport.

| Method  | Path                                         |
| ------- | -------------------------------------------- |
| Receive | `POST /b3nd.v1.B3ndService/Receive`          |
| Read    | `POST /b3nd.v1.B3ndService/Read`             |
| Observe | `POST /b3nd.v1.B3ndService/Observe` (NDJSON) |
| Status  | `POST /b3nd.v1.B3ndService/Status`           |

## Development

```bash
deno check src/mod.ts
deno test --allow-all libs/
```

## Project Structure

```
src/                       # Subpath entry points (client, server, proto)
libs/
  b3nd-client-grpc/        # GrpcClient
  b3nd-server-grpc/        # grpcServer + createGrpcHandler
  b3nd-proto/              # wire schema, converters, b3nd.proto
```

## Related

- [b3nd-core](https://github.com/bandeira-tech/b3nd-core) — framework foundation
- [b3nd-server-http](https://github.com/bandeira-tech/b3nd-server-http) — HTTP
  server transport

## License

MIT
