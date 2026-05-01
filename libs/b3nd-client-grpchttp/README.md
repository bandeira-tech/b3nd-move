# b3nd-client-grpchttp

`GrpcHttpClient` — `ProtocolInterfaceNode` implementation over `grpcHttpApi`.
Works in any fetch-capable runtime: browsers, Deno, Bun, Node 18+.

## API

### `GrpcHttpClient`

```typescript
import { GrpcHttpClient } from "@bandeira-tech/b3nd-servers/grpc/http/client";

const client = new GrpcHttpClient({ url: "http://localhost:50051" });

await client.receive([["mutable://app/item", { name: "thing" }]]);
const [result] = await client.read("mutable://app/item");
const status = await client.status();

// observe — streams changes as NDJSON
const abort = new AbortController();
for await (const update of client.observe("mutable://app/*", abort.signal)) {
  console.log(update.uri, update.record?.data);
}
```

### `GrpcHttpClientConfig`

```typescript
interface GrpcHttpClientConfig {
  url: string;         // base URL of the grpcHttpApi server
  binary?: boolean;    // true = application/proto; false (default) = application/json
  timeout?: number;    // fetch timeout in ms (observe excluded)
}
```

`binary: false` is recommended for browser devtools visibility. `binary: true`
is more compact on the wire — useful for high-throughput server-to-server calls.

## Connect-web alternative

For web apps already using `@connectrpc/connect-web`, the `B3ndService`
descriptor from `./grpc/proto` can be passed to `createClient()` directly —
see `b3nd-server-grpchttp` README.
