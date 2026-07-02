# Stateless thin MCP — shipped in 0.18.0 (kept for rationale)

This proposal was implemented in **b3nd-move 0.18.0**. The implementation
followed the spirit of the design but diverged from the spec assumed here: the
shipped code vendored the **2025-06-18** Streamable HTTP transport (not the
2026-07-28 RC outlined below) and retained the `initialize`/`initialized`
handshake rather than dropping it. The `Mcp-Method` / `Mcp-Name` header scheme
described in §Wire format reference was not adopted.

The doc is kept as rationale — it explains why the MCP SDK was dropped as a
runtime dependency and what the diagnostic findings were. It is not a current
work item.

## TL;DR

- **Problem:** Vercel Edge rejects b3nd-move outright. Root cause is the MCP SDK
  declared in `dependencies` (manifest-poisoning, not import graph). Cloudflare
  Workers tolerates it via `nodejs_compat`; nobody else will.
- **Spec change in our favor:** RC 2026-07-28 removes the
  `initialize`/`initialized` handshake, removes `Mcp-Session-Id`, and removes
  the standalone GET stream. What's left is JSON-RPC over POST with three
  required headers. Tiny.
- **Proposal:** Hand-roll the transport + dispatcher (~250 LOC total), drop the
  SDK from `dependencies` (keep it in `devDependencies` for test conformance via
  `@modelcontextprotocol/sdk/inMemory.js` until we replace those tests too).
  Unblocks Vercel Edge and every other isolate runtime that has an allowlist.
- **Scope:** HTTP transport + the rig dispatcher. WS and stdio stay SDK-free in
  spirit; WS is already a thin wrapper, stdio lives in `dev/` and can keep using
  the SDK until someone needs it elsewhere.
- **Risk:** spec conformance bugs. Mitigation: ship the new transport alongside
  the old one for one minor version, validate against
  `@modelcontextprotocol/inspector` and Claude Desktop, then delete the SDK
  path.

## The problem in detail

`cf.demo.b3nd` works on Cloudflare Workers because CF Workers carries the
`nodejs_compat` flag — `node:tls`, `node:http`, `node:stream`, `node:crypto` all
polyfill. The MCP SDK's server barrel re-exports modules that use those
(`sse.js`, `stdio.js`), and CF's bundler shims them.

Vercel Edge has no such polyfill. More importantly, Vercel's bundler does
**manifest-based package rejection**: if a package's `package.json` declares a
dependency that the bundler considers Edge- unsafe, every module exported by
that package is rejected — even ones that don't transitively import the bad
bits. We confirmed this empirically (see
[Diagnostic findings](#diagnostic-findings)).

So: b3nd-move depending on `@modelcontextprotocol/sdk` poisons every module
b3nd-move exports — `router/errors`, `http/service`, `http-get-content/service`,
the lot. The first consumer to hit this was
[`b3nd-free/src/vercel/`](https://github.com/rafb43/b3nd-free/tree/main/src/vercel),
which has to run on the Node serverless runtime as a workaround. We want it back
on Edge.

The same problem will hit anyone trying b3nd-move on:

- Vercel Edge Functions
- Deno Deploy
- Netlify Edge Functions
- Bun's runtime in some configurations
- Any future "V8-isolate-only" host with a strict allowlist

## Diagnostic findings

Four-stub experiment against Vercel Edge — each stub imported one package, then
deployed and checked the bundle error list.

| Stub                                                                               | Result     |
| ---------------------------------------------------------------------------------- | ---------- |
| `@jsr/bandeira-tech__b3nd-save`                                                    | ✓ deploys  |
| `@jsr/bandeira-tech__b3nd-core`                                                    | ✓ deploys  |
| `@bufbuild/protobuf`                                                               | ✓ deploys  |
| `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`                    | ✗ rejected |
| `@jsr/bandeira-tech__b3nd-move/router/errors` _(pure error classes, zero imports)_ | ✗ rejected |
| `@jsr/bandeira-tech__b3nd-move/http/service`                                       | ✗ rejected |

Conclusions:

1. The JSR shim format is innocent — `b3nd-save` and `b3nd-core` deploy fine.
   Don't go chasing publishing-pipeline ghosts.
2. `@modelcontextprotocol/sdk` is the only direct offender among b3nd-move's
   three deps. `@bufbuild/protobuf` is fine.
3. `router/errors.js` has zero imports and got rejected anyway — manifest-level
   rejection, not import-graph analysis.
4. **The only way to unblock b3nd-move on Vercel Edge is to remove MCP SDK from
   its `dependencies`.** No clever import path or tree-shake trick gets us out
   of this.

Tested with Vercel CLI 54.14.0, Edge runtime, June 2026.

## The 2026-07-28 RC — the part that makes this cheap

Blog post:
<https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/>

Draft spec for the transport:
<https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http>

Things removed from Streamable HTTP that we no longer need to implement:

- ❌ `initialize` / `initialized` handshake (SEP-2575)
- ❌ `Mcp-Session-Id` header and protocol-level sessions (SEP-2567)
- ❌ Standalone GET stream for server-initiated messages
- ❌ Stream resumability via `Last-Event-ID`
- ❌ Server-initiated JSON-RPC requests on SSE streams (replaced by embedded
  `InputRequiredResult` per MRTR, which our toolset doesn't use)

Things still required:

- ✅ JSON-RPC 2.0 envelope (UTF-8)
- ✅ `POST` to the single MCP endpoint
- ✅ Three request headers: `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name`
  (for `tools/call` / `resources/read` / `prompts/get`)
- ✅ Response is either `application/json` (one JSON-RPC response) or
  `text/event-stream` (SSE — for `notifications/progress` etc. before the final
  response)
- ✅ Server-side header↔body validation; mismatch → `400 Bad Request` with
  JSON-RPC error code `-32001` (`HeaderMismatch`)
- ✅ `Origin` header validation; invalid → `403 Forbidden`
- ✅ Notifications: `202 Accepted`, no body
- ✅ Unknown method: `404 Not Found` with JSON-RPC error `-32601`
- ✅ Unsupported protocol version: `400 Bad Request` with
  `UnsupportedProtocolVersionError` carrying `supported` versions
- ✅ Backwards compat: old clients still try `initialize` first; the spec
  recommends a detection dance (see below)

For b3nd's surface (`b3nd_receive`, `b3nd_read`, `b3nd_status`, `b3nd://*`
resources), we don't need progress notifications, sampling, elicitation, or
roots. **A pure POST→`application/json` server covers 100% of the b3nd use
case.** SSE is opt-in; we can ship without it initially.

## Scope of work on this branch

| Step | File                                  | Action                                                                                                                                                         |
| ---- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `deno.json` `imports`                 | Remove `@modelcontextprotocol/sdk/*` runtime imports; keep `inMemory.js`/`client/*` only for tests, behind a `tests/` import scope                             |
| 2    | `src/mcp/wire.ts` _(new)_             | JSON-RPC envelope types + parse/serialize + error codes                                                                                                        |
| 3    | `src/mcp/dispatcher.ts` _(new)_       | `buildMcpDispatcher(rig, opts)` — pure method→handler map, no SDK                                                                                              |
| 4    | `src/mcp/service.ts` _(refactor)_     | Re-exports `buildMcpDispatcher` as `buildMcpServer` for one version (deprecation shim); tool/resource definitions stay as `const TOOLS`/`const RESOURCES`      |
| 5    | `src/mcp/http/service.ts` _(rewrite)_ | Hand-rolled Streamable HTTP — POST handler, header validation, dispatch, response shaping                                                                      |
| 6    | `src/mcp/ws/service.ts` _(refactor)_  | Already a thin transport-shim — point it at `buildMcpDispatcher` directly, drop the SDK `Transport` interface                                                  |
| 7    | `tests/mcp/*`                         | Replace InMemoryTransport-based conformance tests with direct dispatcher tests; add a Streamable HTTP wire-level test using `fetch` against the new transport  |
| 8    | `dev/serve.ts` (stdio)                | Either drop stdio support, or keep the SDK path as a CLI-only build (not shipped to consumers). Stdio is dev-time, not runtime.                                |
| 9    | `deno.json`                           | Bump version → `0.18.0`. Removing a `dependencies` entry is a minor on JSR semver because consumers can no longer rely on the SDK being installed transitively |
| 10   | `README.md` + `src/mcp/README.md`     | Document the protocol revision, the dropped SDK, and migration notes                                                                                           |

The pieces marked _new_ / _rewrite_ should be self-contained — about 250 LOC
total, breakdown below.

## Wire format reference (2026-07-28)

Quoted-where-it-matters from the spec; not exhaustive. Verbatim spec links at
the bottom of this doc.

### Endpoint

Single path, server-defined (commonly `/mcp`). Accepts **POST only**. GET and
DELETE → `405 Method Not Allowed`.

### Required request headers

| Header                 | Required for                                             | Value                                                                                  |
| ---------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `Content-Type`         | all POSTs                                                | `application/json`                                                                     |
| `Accept`               | all POSTs                                                | MUST list both `application/json` and `text/event-stream`                              |
| `MCP-Protocol-Version` | all POSTs                                                | e.g. `2026-07-28` — MUST match `_meta.io.modelcontextprotocol/protocolVersion` in body |
| `Mcp-Method`           | all POSTs                                                | echoes `method` from JSON-RPC body                                                     |
| `Mcp-Name`             | `tools/call`, `resources/read`, `prompts/get`            | echoes `params.name` or `params.uri`                                                   |
| `Mcp-Param-{Name}`     | when the tool's schema marks a param with `x-mcp-header` | encoded per spec §Value Encoding (incl. base64 for non-ASCII / sentinel-collisions)    |
| `Origin`               | (browser clients)                                        | server MUST validate; invalid → `403`                                                  |

If any required standard header is missing OR a header value doesn't match the
body, respond `400 Bad Request` with JSON-RPC error `-32001` (`HeaderMismatch`).

### Body — JSON-RPC 2.0

Request:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "b3nd_receive",
    "arguments": { "messages": [["mutable://x", 42]] },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "X", "version": "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

Notification: same shape, no `id`.

The client **MUST NOT** send JSON-RPC responses (the protocol no longer allows
server-initiated requests). Only requests and notifications are inbound;
responses are always outbound.

### Response shapes

| Body kind                      | Status | Content-Type        | Body                                                 |
| ------------------------------ | ------ | ------------------- | ---------------------------------------------------- |
| Request → result               | `200`  | `application/json`  | single JSON-RPC response                             |
| Request → result via streaming | `200`  | `text/event-stream` | SSE — notifications, then final response, then close |
| Notification (accepted)        | `202`  | n/a                 | empty body                                           |
| Notification (rejected)        | `400`  | n/a (or json)       | optional JSON-RPC error (no `id`)                    |
| Validation failure             | `400`  | `application/json`  | JSON-RPC error `-32001` `HeaderMismatch`             |
| Unknown method                 | `404`  | `application/json`  | JSON-RPC error `-32601` `Method not found`           |
| Unsupported version            | `400`  | `application/json`  | JSON-RPC error `UnsupportedProtocolVersionError`     |
| Bad Origin                     | `403`  | n/a (or json)       | optional JSON-RPC error (no `id`)                    |
| Old GET/DELETE                 | `405`  | n/a                 | none                                                 |

### SSE response format

When choosing `text/event-stream`:

- Header: `Content-Type: text/event-stream` plus `X-Accel-Buffering: no`
- Each event is `data: <json-rpc-message>\n\n`
- Notifications first, then final JSON-RPC response, then server closes
- Per-event `id:` not required (no resumability in this revision)
- Closing the stream from the client = cancellation

For b3nd's three tools we never need to send progress notifications, so the JSON
branch is always sufficient. SSE is a future-proofing hook; defer the
implementation until a tool actually needs progress.

### Backwards compatibility (old clients with initialize)

The spec recommends:

- Client tries modern POST first.
- On `400` the client checks the body — modern servers reply with a recognized
  JSON-RPC error; old servers don't.
- If not recognized, client falls back to `initialize`.

For _server-side_ backwards compat (an old client speaking 2025-06-18 to a new
b3nd-move server):

- The spec allows the server to treat a POST without `MCP-Protocol-Version` as
  `2025-03-26` (legacy).
- Easier: don't bother. Old clients will see `400 HeaderMismatch` with our
  advertised `supported: ["2026-07-28"]` and the client library handles fallback
  if it supports both eras.
- This is a fine choice for b3nd because b3nd's MCP surface targets modern
  Claude/MCP-Inspector clients that already track the spec.

Decision: server-side backwards compat is out of scope for this branch. Document
the cutover; ship.

## Package layout after this branch

```
src/mcp/
├── README.md                # rewrite — refer to 2026-07-28 spec
├── wire.ts                  # NEW — JSON-RPC types + errors + parsing
├── dispatcher.ts            # NEW — buildMcpDispatcher(rig, opts)
├── service.ts               # REFACTOR — re-export, keep tool/resource defs
├── http/
│   ├── README.md
│   └── service.ts           # REWRITE — Streamable HTTP, no SDK
└── ws/
    ├── service.ts           # REFACTOR — point at dispatcher
    └── transport.ts         # DELETE — was an SDK Transport adapter

tests/mcp/
├── dispatcher.test.ts       # NEW — direct dispatch tests
├── http.test.ts             # NEW — wire-level fetch() tests
└── conformance.test.ts      # REPLACES the old InMemory SDK conformance
```

## Implementation skeleton

The next agent should fill these in. The shapes below are TS that typechecks at
the boundaries; the bodies are stubs.

### `src/mcp/wire.ts`

```ts
/**
 * JSON-RPC 2.0 envelope, MCP-flavored.
 *
 * No SDK. Hand-rolled because the SDK pulls in node:tls/http/stream
 * via barrels we don't need (sse.js, stdio.js), poisoning every
 * Edge bundler's allowlist for the whole b3nd-move package.
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: T;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcErrorBody;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse
  | JsonRpcErrorResponse;

export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  HEADER_MISMATCH: -32001,
} as const;

export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_SUPPORTED_VERSIONS = [MCP_PROTOCOL_VERSION] as const;

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_CLIENT_CAPABILITIES =
  "io.modelcontextprotocol/clientCapabilities";

/** Strict-mode parser; returns a JsonRpcErrorResponse on malformed input. */
export function parseEnvelope(
  body: string,
): JsonRpcRequest | JsonRpcNotification | JsonRpcErrorResponse {
  // TODO: parse, validate jsonrpc === "2.0", classify request vs
  // notification by presence of `id`, return a proper error envelope
  // on parse failures.
  throw new Error("unimplemented");
}

export function jsonRpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}
```

### `src/mcp/dispatcher.ts`

```ts
/**
 * Pure method→handler map. No transport concerns. Same role the SDK's
 * `Server` played, minus the framework noise.
 *
 * Each handler is `(params, ctx) => Promise<result>`. ctx is the
 * per-request abort signal; throw a `JsonRpcError` to fail.
 */
import type { Rig } from "@bandeira-tech/b3nd-core";
import {
  readAction,
  receiveAction,
  statusAction,
} from "../actions/standard.ts";
import {
  JSON_RPC_ERRORS,
  jsonRpcError,
  type JsonRpcErrorResponse,
} from "./wire.ts";

export interface McpDispatcherOptions {
  name?: string;
  version?: string;
}

export type McpMethodHandler = (
  params: Record<string, unknown> | undefined,
  ctx: { signal: AbortSignal },
) => Promise<unknown>;

export interface McpDispatcher {
  readonly name: string;
  readonly version: string;
  readonly methods: ReadonlyMap<string, McpMethodHandler>;
  /** Method names this dispatcher considers known. */
  has(method: string): boolean;
}

// Tools + resource definitions stay as const data. They were already
// data-only in the old service.ts; keep them here verbatim.
const TOOLS = [
  // {…}  (lifted from src/mcp/service.ts current TOOLS const)
];

export function buildMcpDispatcher(
  rig: Rig,
  opts: McpDispatcherOptions = {},
): McpDispatcher {
  const name = opts.name ?? "b3nd-mcp";
  const version = opts.version ?? "0.1.0";

  const methods = new Map<string, McpMethodHandler>([
    ["tools/list", async () => ({ tools: TOOLS })],
    ["tools/call", async (params, ctx) => {
      // TODO: lift the switch from current service.ts handleCallTool;
      // throw new JsonRpcError(METHOD_NOT_FOUND, …) for unknown tool.
      throw new Error("unimplemented");
    }],
    ["resources/list", async (_, ctx) => {
      // TODO: lift resources list
      throw new Error("unimplemented");
    }],
    ["resources/read", async (params, ctx) => {
      // TODO: lift resources read
      throw new Error("unimplemented");
    }],
    // NEW in 2026-07-28: optional `server/discover` for capabilities
    ["server/discover", async () => ({
      name,
      version,
      protocolVersion: "2026-07-28",
      capabilities: { tools: {}, resources: {} },
    })],
  ]);

  return {
    name,
    version,
    methods,
    has: (m) => methods.has(m),
  };
}
```

### `src/mcp/http/service.ts`

```ts
/**
 * Streamable HTTP transport — 2026-07-28 revision. Stateless: every
 * POST is a complete RPC. No sessions, no GET stream, no DELETE.
 *
 * Returns `(Request) => Promise<Response>` — fetch-shaped, runs on any
 * Web-standard host (CF Workers, Vercel Edge, Vercel Node via the
 * adapter consumers already write, Deno, Bun).
 */
import type { Rig } from "@bandeira-tech/b3nd-core";
import {
  buildMcpDispatcher,
  type McpDispatcher,
  type McpDispatcherOptions,
} from "../dispatcher.ts";
import {
  JSON_RPC_ERRORS,
  jsonRpcError,
  type JsonRpcErrorResponse,
  type JsonRpcNotification,
  type JsonRpcRequest,
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_VERSIONS,
  META_PROTOCOL_VERSION,
  parseEnvelope,
} from "../wire.ts";

const ACCEPTED_ORIGINS_DEFAULT: ReadonlySet<string> | "any" = "any";

export interface McpHttpOptions extends McpDispatcherOptions {
  /** Allowed Origin values. `"any"` opts out of validation (server-to-server). */
  allowedOrigins?: ReadonlySet<string> | "any";
}

export function mcpHttpApi(
  rig: Rig,
  opts: McpHttpOptions = {},
): (req: Request) => Promise<Response> {
  const dispatcher = buildMcpDispatcher(rig, opts);
  const allowedOrigins = opts.allowedOrigins ?? ACCEPTED_ORIGINS_DEFAULT;

  return async (req: Request): Promise<Response> => {
    // 1. Method check — only POST. GET/DELETE => 405.
    if (req.method !== "POST") {
      return new Response(null, { status: 405 });
    }

    // 2. Origin validation (spec §Security).
    if (allowedOrigins !== "any") {
      const origin = req.headers.get("origin");
      if (origin && !allowedOrigins.has(origin)) {
        return new Response(null, { status: 403 });
      }
    }

    // 3. Protocol version header.
    const versionHeader = req.headers.get("mcp-protocol-version");
    if (!versionHeader) {
      return jsonRpcResponse(
        jsonRpcError(
          null,
          JSON_RPC_ERRORS.HEADER_MISMATCH,
          "Missing MCP-Protocol-Version header",
        ),
        400,
      );
    }
    if (!MCP_SUPPORTED_VERSIONS.includes(versionHeader as never)) {
      return jsonRpcResponse(
        jsonRpcError(
          null,
          JSON_RPC_ERRORS.HEADER_MISMATCH,
          `Unsupported protocol version: ${versionHeader}`,
          { supported: MCP_SUPPORTED_VERSIONS },
        ),
        400,
      );
    }

    // 4. Parse body.
    const bodyText = await req.text();
    const envelope = parseEnvelope(bodyText);
    if ("error" in envelope) {
      return jsonRpcResponse(envelope, 400);
    }

    // 5. Header↔body method match (Mcp-Method).
    const methodHeader = req.headers.get("mcp-method");
    if (methodHeader !== envelope.method) {
      return jsonRpcResponse(
        jsonRpcError(
          "id" in envelope ? envelope.id : null,
          JSON_RPC_ERRORS.HEADER_MISMATCH,
          `Mcp-Method header (${methodHeader}) does not match body (${envelope.method})`,
        ),
        400,
      );
    }

    // 6. Mcp-Name validation for the methods that require it.
    if (
      envelope.method === "tools/call" ||
      envelope.method === "resources/read" ||
      envelope.method === "prompts/get"
    ) {
      const nameHeader = req.headers.get("mcp-name");
      const bodyName = envelope.method === "resources/read"
        ? (envelope.params?.uri as string | undefined)
        : (envelope.params?.name as string | undefined);
      if (!nameHeader || nameHeader !== bodyName) {
        return jsonRpcResponse(
          jsonRpcError(
            "id" in envelope ? envelope.id : null,
            JSON_RPC_ERRORS.HEADER_MISMATCH,
            `Mcp-Name header does not match ${envelope.method} target`,
          ),
          400,
        );
      }
    }

    // 7. Verify _meta.protocolVersion matches the header.
    const metaVersion =
      (envelope.params?._meta as Record<string, unknown> | undefined)
        ?.[META_PROTOCOL_VERSION];
    if (metaVersion !== versionHeader) {
      return jsonRpcResponse(
        jsonRpcError(
          "id" in envelope ? envelope.id : null,
          JSON_RPC_ERRORS.HEADER_MISMATCH,
          "_meta.protocolVersion does not match MCP-Protocol-Version header",
        ),
        400,
      );
    }

    // 8. Notification path.
    if (!("id" in envelope)) {
      // Notifications are accepted with 202 and no body.
      // We don't have any meaningful notifications to handle today.
      return new Response(null, { status: 202 });
    }

    // 9. Request path.
    const handler = dispatcher.methods.get(envelope.method);
    if (!handler) {
      return jsonRpcResponse(
        jsonRpcError(
          envelope.id,
          JSON_RPC_ERRORS.METHOD_NOT_FOUND,
          `Method not found: ${envelope.method}`,
        ),
        404,
      );
    }

    try {
      const result = await handler(envelope.params, { signal: req.signal });
      return jsonRpcResponse({
        jsonrpc: "2.0",
        id: envelope.id,
        result,
      }, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonRpcResponse(
        jsonRpcError(envelope.id, JSON_RPC_ERRORS.INTERNAL_ERROR, msg),
        200, // JSON-RPC convention: 200 with error envelope, not HTTP error
      );
    }
  };
}

function jsonRpcResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
```

That's the whole HTTP transport — ~120 LOC including comments and
header-validation branches. Drop-in replacement for the old `mcpHttpApi`, same
exported signature.

### `src/mcp/service.ts` shim

Keep the file but reduce it to a re-export plus a deprecation note, so consumers
who imported `buildMcpServer` keep working through one minor cycle:

```ts
/**
 * @deprecated Use `buildMcpDispatcher` from `./dispatcher.ts`. This
 * shim returns a dispatcher under the old name for one release.
 */
export { buildMcpDispatcher as buildMcpServer } from "./dispatcher.ts";
export type { McpDispatcherOptions as McpServerOptions } from "./dispatcher.ts";
```

Move the `TOOLS` const definition into `dispatcher.ts`. It's the same data, just
a different home.

## Migration

For consumers (cf.demo.b3nd, vercel.demo.b3nd, anyone else):

- `mcpHttpApi(rig, { name, version })` — unchanged signature, still returns a
  `(Request) => Promise<Response>`.
- `buildMcpServer` continues to work in 0.18.0 via the shim; emits a deprecation
  log (optional). Delete in 0.19.0.
- Tool input shapes unchanged — `b3nd_receive`/`b3nd_read`/`b3nd_status`
  parameters and outputs are identical.
- Resource URI scheme unchanged — `b3nd://<program>`.
- **Client-facing breaking change**: clients speaking 2025-06-18 with the old
  `initialize` handshake will get `400 HeaderMismatch` from the server. The
  spec's recommended fallback is for clients to detect modern vs. legacy by
  inspecting that 400 response. Modern Claude Desktop / MCP Inspector should
  handle this automatically; older clients pinned to 2025-06-18 won't.

Bundle wins: drop `@modelcontextprotocol/sdk` from `dependencies` (keep in
`devDependencies` for tests) and the bundle shrinks considerably. b3nd-move now
deploys on Vercel Edge, Deno Deploy, Netlify Edge, etc. The cloudflare image
keeps working unchanged.

## Testing

Replace tests in two phases:

1. **Unit tests on the dispatcher.** `tests/mcp/dispatcher.test.ts` — construct
   a Rig with a MemoryStore, build the dispatcher, call handlers directly. No
   transport involved. Covers tool dispatch and resource read end-to-end.

2. **Wire-level integration tests on the HTTP transport.** Use `fetch()` against
   `mcpHttpApi(rig)` directly. Tests cover:
   - Missing/mismatched `MCP-Protocol-Version` → `400 -32001`
   - Missing/mismatched `Mcp-Method` → `400 -32001`
   - Missing/mismatched `Mcp-Name` on `tools/call` → `400 -32001`
   - Unsupported version → `400` with `supported` array
   - Unknown method → `404 -32601`
   - Successful `tools/list` → `200` JSON envelope
   - Successful `tools/call b3nd_receive` → 200 with result content
   - Successful `resources/read` of `b3nd://*`
   - Notification → `202` empty body
   - Bad origin → `403`
   - GET / DELETE → `405`

3. **Conformance smoke against `@modelcontextprotocol/inspector`** (manual or
   scripted). Inspector speaks the modern wire — verifying our server passes its
   checks is the best external validation.

The existing `InMemoryTransport`-based SDK conformance tests should be deleted,
not migrated. They were testing SDK glue we no longer use.

## What this branch should NOT do

- Don't touch stdio. `dev/serve.ts` can keep using the SDK; it's a CLI
  dev-server, not a published surface.
- Don't add SSE support. Sketch the response branch comment in the HTTP handler,
  but the `application/json` path covers every b3nd tool currently. Adding SSE
  properly means adding a `text/event-stream` encoder, a `ReadableStream`
  writer, and progress-notification plumbing through the dispatcher — all
  premature for what we serve.
- Don't add MRTR (Multi Round-Trip Requests / `InputRequiredResult`). b3nd's
  tools are pure RPC. No sampling, no elicitation, no roots.
- Don't try to keep backwards compat with the 2025-06-18 transport on the server
  side. Document the cutover; modern clients handle it via the standard fallback
  dance.

## Open questions for the next agent

1. **Should `buildMcpServer` shim throw a runtime warning on first call, or stay
   silent?** Lean silent — the deprecation lives in the TSDoc and CHANGELOG.
   Loud runtime warnings are user-hostile when the consumer can't fix it without
   a version bump.

2. **`x-mcp-header` annotations** — the spec says clients **MUST** support
   `Mcp-Param-{Name}` mirroring of tool parameters tagged with `x-mcp-header`.
   Our server **MAY** designate them. b3nd's three current tools don't need
   this. Skip for now; revisit when a real use case appears.

3. **`server/discover` method** — included in the skeleton dispatcher. The spec
   hints at it but doesn't seem to require it at the server layer. Check the
   final spec when 2026-07-28 ships; remove if not normative.

4. **WS transport** — the existing `src/mcp/ws/service.ts` already adapts a
   WebSocket as an SDK `Transport`. With the dispatcher model, WS becomes:
   - Receive `socket.message` → parse JSON-RPC envelope
   - Dispatch through `buildMcpDispatcher` methods map
   - Send response with `socket.send(JSON.stringify(response))`

   ~30 LOC. Worth bundling into this branch; the WS path is small enough that
   doing it now is cheaper than coming back. The `transport.ts` file disappears
   entirely.

5. **stdio** — same story as WS but bigger. The b3nd-move stdio surface is
   dev-only (`dev/serve.ts --mcp`). Either:
   - Move it to a separate dev-only package, or
   - Leave it depending on the SDK as a dev dependency only

   The second option is simpler and doesn't break Claude Desktop integration
   paths.

6. **Verify the spec is final** before merging. The 2026-07-28 RC may still
   churn. If `Mcp-Method` / `Mcp-Name` names change between RC and GA, this
   branch needs a rename pass. Keep the wire constants in `wire.ts` so future
   churn is one file.

## Reference URLs

- 2026-07-28 RC blog post:
  <https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/>
- Draft transports overview:
  <https://modelcontextprotocol.io/specification/draft/basic/transports>
- Draft Streamable HTTP spec:
  <https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http>
- Draft changelog:
  <https://modelcontextprotocol.io/specification/draft/changelog>
- Current (2025-06-18) Streamable HTTP, for comparison:
  <https://modelcontextprotocol.io/specification/2025-06-18/basic/transports>
- The diagnostic experiment that confirmed manifest-poisoning was the root
  cause: PR in `b3nd-free` repo, branch
  `feat(vercel): ship the image — Node runtime + pg + provision script` (see
  commit history; the diagnostic stubs lived briefly in
  `src/vercel/api/diag/*.ts` and were not pushed).

## Related work upstream

The MCP project has open issues about node-deps and Edge compat — worth checking
before starting:

- <https://github.com/modelcontextprotocol/typescript-sdk/issues?q=is%3Aissue+edge>
- <https://github.com/modelcontextprotocol/typescript-sdk/issues?q=is%3Aissue+node%3Atls>

If the SDK fixes its barrel exports in a future release such that Vercel Edge
accepts it, this proposal becomes obsolete and we can revert to using the SDK.
Not betting on it.
