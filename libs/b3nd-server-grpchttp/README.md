# b3nd-server-grpchttp

gRPC-HTTP service — B3ndService as a fetch handler, plus a `Deno.serve`
resolver. Speaks the [Connect protocol](https://connectrpc.com/): JSON or
binary protobuf over plain HTTP/1.1 or HTTP/2.

## API

### `grpcHttpApi(rig)` — universal

Pure `(Request) => Promise<Response>` handler. Plug into any HTTP runtime.

```typescript
import { grpcHttpApi } from "@bandeira-tech/b3nd-servers/grpc/http/api";
import { withCors } from "@bandeira-tech/b3nd-servers";

const handler = withCors(grpcHttpApi(rig), { origin: "*" });
export default { fetch: handler };  // Cloudflare Worker, Bun, Node, …
```

### `grpcHttpServer(options?)` — Deno only

`ServerResolver` that wraps `grpcHttpApi` with `Deno.serve`.

```typescript
import { grpcHttpServer } from "@bandeira-tech/b3nd-servers/grpc/http/server";

const resolver = grpcHttpServer({ port: 50051, cors: "*" });
const server = resolver.create(rig);
await server.start();
```

### `GrpcHttpServerOptions`

```typescript
interface GrpcHttpServerOptions {
  port?: number;      // default: 50051
  hostname?: string;  // default: "0.0.0.0"
  cors?: string;
}
```

## Wire format

| Method  | Path                                | Encoding |
|---------|-------------------------------------|----------|
| Receive | `POST /b3nd.v1.B3ndService/Receive` | JSON or binary |
| Read    | `POST /b3nd.v1.B3ndService/Read`    | JSON or binary |
| Observe | `POST /b3nd.v1.B3ndService/Observe` | NDJSON (always) |
| Status  | `POST /b3nd.v1.B3ndService/Status`  | JSON or binary |

Encoding is negotiated by `Content-Type`:
- `application/json` or `application/connect+json` → JSON
- `application/proto`, `application/connect+proto`, `application/grpc` → binary

`bytes` fields are base64-encoded automatically in JSON mode by `@bufbuild/protobuf`.

## Connect-web (browsers)

Unary methods (Receive, Read, Status) are compatible with `@connectrpc/connect-web`:

```typescript
import { B3ndService } from "@bandeira-tech/b3nd-servers/grpc/proto";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

const client = createClient(
  B3ndService,
  createConnectTransport({ baseUrl: "https://api.example.com" }),
);
const res = await client.status({});
```
