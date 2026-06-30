# src

The moving layer for B3nd. Each transport directory follows the same two-file
convention.

## Convention

```
src/<transport>/
  service.ts  ← portable handler (works in any fetch / SDK runtime)
  client.ts   ← ProtocolInterfaceNode over the wire
```

`client.ts` speaks the wire shape `service.ts` exposes. Every transport's
surface collapses to these two files. No barrels — import from the canonical
file directly.

**Runtime binding lives outside `src/`.** Spinning up `Deno.serve`, plumbing
stdio, draining WebSocket connections — none of that is part of the published
package. Pair `service.ts` with whatever your host runtime offers, or use
`dev/serve.ts` (and `deno task serve`) for local-dev convenience. Production
runners and SDKs build their own equivalents.

**Cross-cutting concerns are out of scope too.** CORS, auth wrappers, multi-
server orchestration — wrap the `service` handlers yourself, or reach for a
higher-level SDK. The move layer exists to do encoding / transport / decoding
and nothing else.

## Usage

```typescript
import { httpApi } from "@bandeira-tech/b3nd-move/http/service";
import { grpcHttpApi } from "@bandeira-tech/b3nd-move/grpc/http/service";
import { httpOutputsFrame } from "@bandeira-tech/b3nd-move/codecs/http";
import { grpcProto } from "@bandeira-tech/b3nd-move/codecs/grpc";

// Deno
Deno.serve({ port: 3000 }, httpApi(rig, { codec: httpOutputsFrame() }));

// Cloudflare Workers / Bun
export default { fetch: grpcHttpApi(rig, { codec: grpcProto() }) };

// Node — pair with @hono/node-server, express, node:http, …
```

For an in-repo example that builds a `stubRig`-backed runner and starts several
transports at once, see [`dev/serve.ts`](../dev/serve.ts) and the
[`serve` task](../README.md#local-dev-serve-task).

## Per-transport docs

- [`http/`](./http/README.md) — HTTP + NDJSON observe
- [`ws/`](./ws/README.md) — WebSocket framing
- [`grpc/http/`](./grpc/http/README.md) — gRPC-over-HTTP (JSON + binary)
- [`grpc/proto/`](./grpc/proto/README.md) — generated wire types + converters
- [`mcp/`](./mcp/README.md) — Model Context Protocol (stdio)
