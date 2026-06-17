/**
 * @module
 * Build the MCP request dispatcher for a `Rig` — three tools (receive,
 * read, status) plus the `b3nd://*` resource surface.
 *
 * Returns a `MinimalServer` configured with the b3nd handlers. Same
 * external contract as before (`buildMcpServer(rig, opts)`), now backed
 * by our own dispatcher instead of the SDK's `Server`. Method routing
 * is by JSON-RPC method name (string) rather than Zod schema.
 *
 * See ../../MCP-STATELESS-THIN.md for the rationale (drop SDK runtime
 * dep; unblock Vercel Edge etc.).
 */

import type { Rig } from "@bandeira-tech/b3nd-core";
import {
  readAction,
  receiveAction,
  statusAction,
} from "../actions/standard.ts";
import { MinimalServer } from "./server.ts";

export interface McpServerOptions {
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
  rig: Rig,
  opts: McpServerOptions = {},
): MinimalServer {
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
          const { messages } = args as { messages: [string, unknown][] };
          const results = await receiveAction(rig, [messages], ctx.signal);
          return {
            content: [{
              type: "text",
              text: JSON.stringify(
                results.map((r, i) => ({
                  uri: messages[i][0],
                  accepted: r.accepted,
                  error: r.error,
                })),
                null,
                2,
              ),
            }],
            isError: results.some((r) => !r.accepted),
          };
        }

        case "b3nd_read": {
          const { urls } = args as { urls: string[] };
          const outputs = await readAction(rig, [urls], ctx.signal);
          return {
            content: [{
              type: "text",
              text: JSON.stringify(
                outputs.map(([uri, payload]) => ({ uri, payload })),
                null,
                2,
              ),
            }],
          };
        }

        case "b3nd_status": {
          const result = await statusAction(rig, [], ctx.signal);
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
      const status = await statusAction(rig, [], ctx.signal);
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
      const [output] = await readAction(rig, [[b3ndUri]], ctx.signal);
      const [, payload] = output;
      return {
        contents: [{
          uri: resourceUri,
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2),
        }],
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
