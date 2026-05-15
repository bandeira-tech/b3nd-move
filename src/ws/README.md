# ws

WebSocket transport for B3nd. Persistent connection, request/response over JSON
frames, server-pushed observe events.

## Surface

| File         | Exports                                                                             | Runtime |
| ------------ | ----------------------------------------------------------------------------------- | ------- |
| `server.ts`  | `wsServer`, `WsServerOptions`                                                       | Deno    |
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

**The triplet.**

- `service.ts` (`wsApi(rig)`) is a fetch handler that upgrades to WS. Tied to
  Deno only because it uses `Deno.upgradeWebSocket`. Exposes a `closeAll()`
  lifecycle hook so the server can drain sockets before shutdown.
- `server.ts` (`wsServer(rig, { port })`) wraps it with `Deno.serve` and returns
  a `TransportServer` with `start`/`stop`.
- `client.ts` (`WebSocketClient`) speaks the protocol above with configurable
  reconnection.

## Usage

```typescript
import { wsServer } from "@bandeira-tech/b3nd-move/ws/server";
import { WebSocketClient } from "@bandeira-tech/b3nd-move/ws/client";

const server = wsServer(rig, { port: 8080 });
await server.start();

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

- `wsApi` returns 404 for non-upgrade requests — it does only the WS path.
  WebSocket handshakes are not subject to CORS, so `wsServer` is a no-frills
  `Deno.serve` wrapper. If you need CORS for a sibling HTTP endpoint, run it on
  a separate handler.
- `WsApi.closeAll()` drains sockets gracefully. `wsServer` calls it before
  `server.shutdown()` because `Deno.HttpServer.shutdown` waits for in-flight
  requests and WS connections are long-lived.
- The wire protocol matches `b3nd-core`'s `WebSocketClient` lineage — changing
  it is a breaking wire change.
