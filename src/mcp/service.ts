/**
 * @module
 * Build the MCP request dispatcher for a `Rig` — three tools (receive,
 * read, status) plus the `b3nd://*` resource surface.
 *
 * `buildMcpServer(pin, opts)` requires an operator-declared `McpBatchCodec`
 * in `opts.codec`. The codec controls how tool-call results are serialized
 * into MCP `Content[]` items. Two codecs ship in the catalog:
 *
 * ```ts
 * import { buildMcpServer } from "@bandeira-tech/b3nd-move/mcp/service";
 * import { mcpTextJsonStringify } from "@bandeira-tech/b3nd-move/codecs/mcp";
 *
 * const server = buildMcpServer(pin, { codec: mcpTextJsonStringify() });
 * // or, for byte-faithful resource content:
 * // const server = buildMcpServer(pin, { codec: mcpResourcePerSlot() });
 * ```
 *
 * Returns a `MinimalServer` configured with the b3nd handlers. Method routing
 * is by JSON-RPC method name (string) rather than Zod schema.
 *
 * See ../../docs/MCP-STATELESS-THIN.md for the rationale (drop SDK runtime
 * dep; unblock Vercel Edge etc.).
 */

import type { ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core/types";
import {
  readAction,
  receiveAction,
  statusAction,
} from "../actions/standard.ts";
import type { McpBatchCodec } from "./codec.ts";
import { MinimalServer } from "./server.ts";

export interface McpServerOptions {
  codec: McpBatchCodec;
  name?: string;
  version?: string;
}

const TOOLS = [
  {
    name: "b3nd_receive",
    description:
      "Send messages to the B3nd rig — the unified entry point for all state changes. Each message is [uri, payload]; payload semantics are protocol-defined.",
    inputSchema: {
      type: "object" as const,
      properties: {
        messages: {
          type: "array",
          description: "Array of message tuples [[uri, payload], ...]",
          items: { type: "array", minItems: 2, maxItems: 2 },
        },
      },
      required: ["messages"],
    },
  },
  {
    name: "b3nd_read",
    description:
      "Read data from one or more B3nd urls. A url is a uri + optional ?fn=...&... query. Returns one [uri, payload] tuple per input, in input order.",
    inputSchema: {
      type: "object" as const,
      properties: {
        urls: {
          type: "array",
          description: "Array of urls to read",
          items: { type: "string" },
        },
      },
      required: ["urls"],
    },
  },
  {
    name: "b3nd_status",
    description: "Get the status and capabilities of the B3nd rig.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

export function buildMcpServer(
  pin: ProtocolInterfaceNode,
  opts: McpServerOptions,
): MinimalServer {
  const { codec } = opts;
  const server = new MinimalServer(
    { name: opts.name ?? "b3nd-mcp", version: opts.version ?? "0.1.0" },
    { tools: {}, resources: {} },
  );

  server.setRequestHandler("tools/list", () => ({ tools: TOOLS }));

  server.setRequestHandler("tools/call", async (request, ctx) => {
    const params = request.params as {
      name: string;
      arguments?: Record<string, unknown>;
    };
    const { name, arguments: args } = params;

    try {
      switch (name) {
        case "b3nd_receive": {
          const messages = codec.decodeReceiveArgs(args);
          const results = await receiveAction(pin, [messages], ctx.signal);
          return {
            content: await codec.encodeReceive(results, messages, {
              signal: ctx.signal,
            }),
            isError: results.some((r) => !r.accepted),
          };
        }

        case "b3nd_read": {
          const urls = codec.decodeReadArgs(args);
          const outputs = await readAction(pin, [urls], ctx.signal);
          return {
            content: await codec.encodeRead(outputs, { signal: ctx.signal }),
          };
        }

        case "b3nd_status": {
          const result = await statusAction(pin, [], ctx.signal);
          return {
            content: [{
              type: "text",
              text: JSON.stringify(result, null, 2),
            }],
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ error: message, tool: name }, null, 2),
        }],
        isError: true,
      };
    }
  });

  server.setRequestHandler("resources/list", async (_, ctx) => {
    try {
      const status = await statusAction(pin, [], ctx.signal);
      return {
        resources: (status.schema ?? []).map((program) => ({
          uri: `b3nd://${program}`,
          name: program,
          description: `B3nd program: ${program}`,
          mimeType: "application/json",
        })),
      };
    } catch {
      return { resources: [] };
    }
  });

  server.setRequestHandler("resources/read", async (request, ctx) => {
    const params = request.params as { uri: string };
    const resourceUri = params.uri;
    const b3ndUri = resourceUri.replace(/^b3nd:\/\//, "");
    try {
      const [output] = await readAction(pin, [[b3ndUri]], ctx.signal);
      return {
        contents: await codec.encodeReadResource(output, resourceUri, {
          signal: ctx.signal,
        }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        contents: [{
          uri: resourceUri,
          mimeType: "application/json",
          text: JSON.stringify({ error: message }),
        }],
      };
    }
  });

  return server;
}
