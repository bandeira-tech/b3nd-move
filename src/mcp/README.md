# mcp

Model Context Protocol transport for B3nd. Exposes the rig's data operations as
MCP tools so LLM clients can read and write through the same surface.

## Surface

| File         | Exports                              | Runtime |
| ------------ | ------------------------------------ | ------- |
| `service.ts` | `buildMcpServer`, `McpServerOptions` | any     |

There's no `client.ts` here — MCP clients are written by the LLM host (Claude
Desktop, Cursor, etc.). The PIN-equivalent contract for MCP lives in
`testing/mcp-spec.ts` and uses the official `@modelcontextprotocol/sdk/client`
over `InMemoryTransport`.

## Concepts

**Wire shape.** stdio, framed by the MCP SDK. The server exposes three tools:

| Tool           | Input                               | Maps to            |
| -------------- | ----------------------------------- | ------------------ |
| `b3nd_receive` | `{ messages: [[uri, payload], …] }` | `rig.receive(...)` |
| `b3nd_read`    | `{ urls: string[] }`                | `rig.read(...)`    |
| `b3nd_status`  | `{}`                                | `rig.status()`     |

`observe` is intentionally absent — MCP tools are request/response. If you need
streams, use HTTP/WS.

**Just the service.**

`service.ts` (`buildMcpServer(rig, opts)`) returns a bare MCP `Server`
instance — connect it to any MCP transport (stdio, sockets, in-memory). The
move layer ships only the service; runtime binding (stdio for Claude Desktop,
sockets for custom integrations, in-memory for tests) is the caller's choice.

## Usage

```typescript
import { buildMcpServer } from "@bandeira-tech/b3nd-move/mcp/service";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = buildMcpServer(rig, { name: "my-b3nd-node" });
await server.connect(new StdioServerTransport());
```

For local-dev convenience that wires the stdio dance for you, use
`deno task serve -- --mcp` (see [`dev/serve.ts`](../../dev/serve.ts)).

For in-memory tests:

```typescript
import { buildMcpServer } from "@bandeira-tech/b3nd-move/mcp/service";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const server = buildMcpServer(rig);
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
// hand clientTransport to your MCP Client
```

## Notes

- The tool definitions live as `const` data in `service.ts` — they're the
  surface contract the LLM sees. Changes affect prompt phrasing on the LLM side.
