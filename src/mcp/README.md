# mcp

Model Context Protocol transport for B3nd. Exposes the rig's data operations as
MCP tools so LLM clients can read and write through the same surface.

## Surface

| File                               | Exports                                        | Runtime |
| ---------------------------------- | ---------------------------------------------- | ------- |
| `service.ts`                       | `buildMcpServer`, `McpServerOptions`           | any     |
| `server.ts`                        | `MinimalServer`, `ErrorCode`                   | any     |
| `wire.ts`                          | JSON-RPC types + predicates                    | any     |
| `web-streamable-http-transport.ts` | Streamable HTTP server transport               | any     |
| `http/service.ts`                  | `mcpHttpApi(rig, { codec })` — fetch handler   | any     |
| `ws/service.ts`                    | `mcpWsApi(rig, { codec })` — websocket handler | any     |

There's no `client.ts` here — MCP clients are written by the LLM host (Claude
Desktop, Cursor, etc.). The contract-test for the MCP surface lives in
`tests/suites/mcp-spec.ts` and uses the official upstream MCP client over an
in-memory transport.

## Why no SDK at runtime

b3nd-move 0.18.0 dropped the upstream MCP SDK as a runtime dependency. The SDK
transitively pulls Node-only modules; some isolate runtimes (Vercel Edge, Deno
Deploy, etc.) reject any consumer of the SDK before it even gets to load.
Vendoring the Streamable HTTP transport and writing a small `MinimalServer`
replaces the slice we actually used (~1100 LOC) and keeps the package
isolate-clean.

Tests + `dev/serve.ts` still use the SDK _client_ for conformance — those
imports use direct `npm:` specifiers so they don't go through `deno.json`'s
`imports` map and don't end up in the published manifest.

## Concepts

**Wire shape.** JSON-RPC framed by the vendored Streamable HTTP transport. The
server exposes three tools:

| Tool           | Input                               | Maps to            |
| -------------- | ----------------------------------- | ------------------ |
| `b3nd_receive` | `{ messages: [[uri, payload], …] }` | `rig.receive(...)` |
| `b3nd_read`    | `{ urls: string[] }`                | `rig.read(...)`    |
| `b3nd_status`  | `{}`                                | `rig.status()`     |

`observe` is intentionally absent — MCP tools are request/response. If you need
streams, use HTTP/WS.

**Just the service.**

`service.ts` (`buildMcpServer(rig, opts)`) returns a `MinimalServer` instance —
connect it to any transport that implements the local `Transport` interface. The
move layer ships the service; runtime binding (HTTP, WebSocket, in-memory for
tests) is the caller's choice.

## Usage

HTTP transport (the common production path):

```typescript
import { connection, Rig } from "@bandeira-tech/b3nd-core";
import { mcpHttpApi } from "@bandeira-tech/b3nd-move/mcp/http/service";
import { mcpTextJsonStringify } from "@bandeira-tech/b3nd-move/codecs/mcp";

const rig = new Rig({ routes: { receive: [c], read: [c], observe: [c] } });
Deno.serve({ port: 3000 }, mcpHttpApi(rig, { codec: mcpTextJsonStringify() }));
```

## Notes

- The tool definitions live as `const` data in `service.ts` — they're the
  surface contract the LLM sees. Changes affect prompt phrasing on the LLM side.
