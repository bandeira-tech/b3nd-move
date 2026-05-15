# ws

WebSocket transport for B3nd. Persistent connection, request/response over JSON
frames, server-pushed observe events.

## Surface

| File         | Exports                                                                             | Runtime |
| ------------ | ----------------------------------------------------------------------------------- | ------- |
| `service.ts` | `wsApi`, `WsApi`                                                                    | Deno    |
| `client.ts`  | `WebSocketClient`, `WebSocketClientConfig`, `WebSocketRequest`, `WebSocketResponse` | any     |

## Concepts

**Wire shape.** One persistent socket, JSON frames keyed by `id`:

```text
inbound  → { id, type, payload }
outbound → { id, success: true,  data }
           { id, success: false, error }
```

| `type`           | `payload`        | `data`                                     |
| ---------------- | ---------------- | ------------------------------------------ |
| `receive`        | `Message[]`      | `ReceiveResult[]`                          |
| `read`           | `{ urls }`       | `Output[]`                                 |
| `observe`        | `{ urls }`       | repeated frames, each `Output<string[]>`   |
| `observe-cancel` | `{}` (reuses id) | no reply — active observe emits terminator |
| `status`         | `{}`             | `StatusResult`                             |

Observe streams are terminated by a frame with `data: null` (server
end-of-stream) or by `observe-cancel` from the client.

**The pair.**

- `service.ts` (`wsApi(rig)`) is a fetch handler that upgrades to WS. Tied to
  Deno only because it uses `Deno.upgradeWebSocket`. Exposes a `closeAll()`
  lifecycle hook so callers can drain sockets before shutting down the host HTTP
  server (`Deno.HttpServer.shutdown` waits for in-flight requests, and WS
  connections are long-lived).
- `client.ts` (`WebSocketClient`) speaks the protocol above with configurable
  reconnection.

## Usage

```typescript
import { wsApi } from "@bandeira-tech/b3nd-move/ws/service";
import { WebSocketClient } from "@bandeira-tech/b3nd-move/ws/client";

const handler = wsApi(rig);
const server = Deno.serve({ port: 8080 }, handler);
// On shutdown: drain WS first, then stop the HTTP server.
//   await handler.closeAll();
//   await server.shutdown();

const client = new WebSocketClient({
  url: "ws://localhost:8080",
  reconnect: { enabled: true },
});
await client.receive([["mutable://app/x", { name: "thing" }]]);

const ac = new AbortController();
for await (
  const [_pattern, uris] of client.observe(["mutable://app/*"], ac.signal)
) {
  console.log("changed:", uris);
}
```

## Notes

- `wsApi` returns 404 for non-upgrade requests — it does only the WS path. If
  you need a sibling HTTP endpoint on the same host, run it on a separate
  handler.
- `WsApi.closeAll()` drains sockets gracefully. Always call it before
  `server.shutdown()` for the same reason `dev/serve.ts` does.
- For local-dev convenience that wires this up for you, use
  `deno task serve -- --ws` (see [`dev/serve.ts`](../../dev/serve.ts)).
- The wire protocol matches `b3nd-core`'s `WebSocketClient` lineage — changing
  it is a breaking wire change.
