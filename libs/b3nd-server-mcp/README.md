# b3nd-server-mcp

MCP (Model Context Protocol) transport — exposes a `Rig` as an MCP server
over stdio. Three tools matching `ProtocolInterfaceNode` exactly.

## Tools

| Tool | Maps to | Description |
|---|---|---|
| `b3nd_receive` | `rig.receive(messages)` | Batch write. Each message is `[uri, payload]`; payload semantics are protocol-defined. |
| `b3nd_read` | `rig.read(urls)` | Batch read. Each url is a uri + optional `?fn=...&...` query (e.g. trailing-slash uri lists children via `fn=ls`). |
| `b3nd_status` | `rig.status()` | Health + schema + fns. |

## API

### `mcpServer(options?)` — Deno only

`ServerResolver` that connects `StdioServerTransport` on `start()`.

```typescript
import { createServers } from "@bandeira-tech/b3nd-servers";
import { mcpServer } from "@bandeira-tech/b3nd-servers/mcp/server";

const [server] = createServers(rig, [mcpServer({ name: "my-b3nd" })]);
await server.start();  // connects stdio; runs until process exits
```

### `buildMcpServer(rig, options?)` — any runtime

Returns a bare `@modelcontextprotocol/sdk` `Server` instance without
connecting a transport. Use this when you want to attach your own transport
(e.g. SSE, WebSocket) or compose the MCP server into a larger app.

```typescript
import { buildMcpServer } from "@bandeira-tech/b3nd-servers/mcp/api";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = buildMcpServer(rig, { name: "my-b3nd", version: "1.0.0" });
await server.connect(new StdioServerTransport());
```

### `McpServerOptions`

```typescript
interface McpServerOptions {
  name?: string;     // MCP server name shown to clients (default: "b3nd-mcp")
  version?: string;  // version string (default: "0.1.0")
}
```

## Resources

The server also registers MCP resources from `rig.status().schema`. Each
program (e.g. `mutable`) becomes a readable resource at `b3nd://{program}`.
Any `b3nd://{uri}` resource URI is read directly from the rig.
