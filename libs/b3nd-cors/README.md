# b3nd-cors

CORS middleware for `(Request) => Promise<Response>` handlers.

Used internally by `httpServer` and `grpcHttpServer`. Also exported from
the root subpath for wrapping `httpApi(rig)` or `grpcHttpApi(rig)` directly.

## API

### `withCors(handler, options)`

```typescript
import { withCors } from "@bandeira-tech/b3nd-servers";

const handler = withCors(httpApi(rig), { origin: "*" });
Deno.serve({ port: 3000 }, handler);
```

`OPTIONS` requests get a `204` preflight response. All other responses pass
through with `Access-Control-*` headers merged in.

### `CorsOptions`

```typescript
interface CorsOptions {
  origin: string;      // required — "*" or a specific origin
  methods?: string;    // default: "GET, POST, PUT, DELETE, OPTIONS"
  headers?: string;    // default: "Content-Type, Authorization, Last-Event-ID"
  maxAge?: number;     // default: 86400
}
```
