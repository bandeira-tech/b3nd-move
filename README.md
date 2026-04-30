# B3nd Servers

Optional transport packages for the B3nd framework. Both packages live in this
repo as independent JSR packages — install only the one you need.

[GitHub](https://github.com/bandeira-tech/b3nd-servers)

| Package                                                          | What it ships                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`@bandeira-tech/b3nd-server-http`](./packages/b3nd-server-http) | Hono-backed HTTP `ServerResolver` for serving a B3nd Rig over HTTP.                         |
| [`@bandeira-tech/b3nd-grpc`](./packages/b3nd-grpc)               | Connect-protocol gRPC client + server + wire schema. JSON over HTTP/2, no protobuf codegen. |

Both depend on
[@bandeira-tech/b3nd-core](https://github.com/bandeira-tech/b3nd-core) for
`Rig`, `httpApi`, and the `ServerResolver` contract.

## Why a separate repo

Server transports drag in either Hono (HTTP) or HTTP/2 streaming code (gRPC).
Most consumers of `b3nd-core` only need the framework foundation — types,
encoding, clients, the rig, network primitives. Keeping the server side here
means `b3nd-core` stays small and dependency-free.

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
import { grpcServer } from "@bandeira-tech/b3nd-grpc/server";

const client = new SimpleClient(new MemoryStore());
const rig = new Rig({
  routes: {
    receive: [connection(client, ["*"])],
    read: [connection(client, ["*"])],
  },
});

const servers = createServers(rig, [
  httpServer({ port: 3000, cors: "*" }),
  grpcServer({ port: 50051 }),
]);
await Promise.all(servers.map((s) => s.start()));
```

## Development

```bash
deno task test-all     # Run all package tests
deno task check-all    # Type-check all package entry points
deno lint packages/
deno fmt --check packages/
```

Or run a single package's task by `cd`-ing into it:

```bash
cd packages/b3nd-grpc && deno task test
```

## Project Structure

```
packages/
  b3nd-server-http/   # @bandeira-tech/b3nd-server-http
  b3nd-grpc/          # @bandeira-tech/b3nd-grpc
```

## Related

- [b3nd-core](https://github.com/bandeira-tech/b3nd-core) — framework foundation
- [b3nd-canon](https://github.com/bandeira-tech/b3nd-canon) — protocol-building
  toolkit

## License

MIT
