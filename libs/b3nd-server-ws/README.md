# b3nd-server-ws

WebSocket transport — `wsApi(rig)` as a fetch handler, plus a `Deno.serve`
resolver. Speaks the same wire protocol as
[`@bandeira-tech/b3nd-core`'s `WebSocketClient`](https://jsr.io/@bandeira-tech/b3nd-core).

## API

### `wsApi(rig)` — universal-ish

Pure `(Request) => Promise<Response>` handler. Upgrades the request to a
WebSocket and bridges the WS wire protocol to a `Rig`. Currently requires
`Deno.upgradeWebSocket` — Bun and Node need their own upgrade APIs, which this
lib doesn't paper over yet.

```typescript
import { wsApi } from "@bandeira-tech/b3nd-servers/ws/api";
import { withCors } from "@bandeira-tech/b3nd-servers";

const handler = withCors(wsApi(rig), { origin: "*" });
Deno.serve({ port: 8080 }, handler);
```

### `wsServer(options?)` — Deno only

`ServerResolver` that wraps `wsApi` with `Deno.serve`.

```typescript
import { wsServer } from "@bandeira-tech/b3nd-servers/ws/server";

const resolver = wsServer({ port: 8080, cors: "*" });
const server = resolver.create(rig);
await server.start();
```

### `WsServerOptions`

```typescript
interface WsServerOptions {
  port?: number; // default: 8080
  hostname?: string; // default: "0.0.0.0"
  cors?: string;
}
```

## Wire protocol

JSON frames, matching `b3nd-core`'s `WebSocketRequest`/`WebSocketResponse`:

| Inbound `type`   | Payload                    | Outbound `data`                                        |
| ---------------- | -------------------------- | ------------------------------------------------------ |
| `receive`        | `Message[]`                | `ReceiveResult[]`                                      |
| `read`           | `{ urls: string[] }`       | `Output[]`                                             |
| `status`         | `{}`                       | `StatusResult`                                         |
| `observe`        | `{ urls: string[] }`       | streamed `Output<string[]>` frames, then `null`        |
| `observe-cancel` | `{}` (reuses observe `id`) | _(no reply — the active observe sends its terminator)_ |

Non-upgrade requests get a 404. Compose with `withCors` if browser clients hit
this directly.
