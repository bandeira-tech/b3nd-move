import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Rig } from "@bandeira-tech/b3nd-core";
import { runAction } from "../actions/run.ts";

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

export function buildMcpServer(rig: Rig, opts: McpServerOptions = {}): Server {
  const server = new Server(
    { name: opts.name ?? "b3nd-mcp", version: opts.version ?? "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    () => Promise.resolve({ tools: TOOLS }),
  );

  server.setRequestHandler(CallToolRequestSchema, async (
    request: { params: { name: string; arguments?: Record<string, unknown> } },
  ) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "b3nd_receive": {
          const { messages } = args as { messages: [string, unknown][] };
          const results = await runAction(rig, {
            action: "receive",
            outputs: messages,
          });
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
          const outputs = await runAction(rig, { action: "read", urls });
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
          const result = await runAction(rig, { action: "status" });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    try {
      const status = await runAction(rig, { action: "status" });
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

  server.setRequestHandler(ReadResourceRequestSchema, async (
    request: { params: { uri: string } },
  ) => {
    const resourceUri = request.params.uri;
    const b3ndUri = resourceUri.replace(/^b3nd:\/\//, "");
    try {
      const [output] = await runAction(rig, {
        action: "read",
        urls: [b3ndUri],
      });
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
