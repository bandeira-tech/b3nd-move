# b3nd-server-http

HTTP transport — `httpApi(rig)` from b3nd-core wrapped with `Deno.serve` and
optional CORS. Deno only.

## API

### `httpServer(options?)`

Returns a `ServerResolver`. Pass it to `createServers` or call `.create(rig)` directly.

```typescript
import { httpServer } from "@bandeira-tech/b3nd-servers/http";

const resolver = httpServer({ port: 3000, cors: "*" });
const server = resolver.create(rig);
await server.start();   // binds Deno.serve on 0.0.0.0:3000
// …
await server.stop();    // graceful shutdown
```

### `HttpServerOptions`

```typescript
interface HttpServerOptions {
  port?: number;      // default: 3000
  hostname?: string;  // default: "0.0.0.0"
  cors?: string;      // CORS origin — overrides ServerComposition.cors
  statusMeta?: ...;   // forwarded to httpApi() from b3nd-core
}
```

CORS precedence: `options.cors` > `composition.cors` > no CORS.

## Node / non-Deno

For runtimes without `Deno.serve`, use `httpApi(rig)` from `@bandeira-tech/b3nd-core`
directly and feed it to your own HTTP server:

```typescript
import { httpApi } from "@bandeira-tech/b3nd-core";
import { withCors } from "@bandeira-tech/b3nd-servers";

const handler = withCors(httpApi(rig), { origin: "*" });
// Hono, Express, Cloudflare Worker, raw node:http, …
export default { fetch: handler };
```
