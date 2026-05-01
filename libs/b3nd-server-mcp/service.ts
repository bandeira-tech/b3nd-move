import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Rig } from "@bandeira-tech/b3nd-core";

export interface McpServerOptions {
  name?: string;
  version?: string;
}

const TOOLS = [
  {
    name: "b3nd_receive",
    description:
      "Send messages to the B3nd rig — the unified entry point for all state changes. Each message is [uri, payload]; a null payload deletes the URI.",
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
      "Read data from one or more B3nd URIs. Pass a trailing slash to list all children of a path.",
    inputSchema: {
      type: "object" as const,
      properties: {
        uris: {
          description: "A single URI string or an array of URIs to read",
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
      },
      required: ["uris"],
    },
  },
  {
    name: "b3nd_status",
    description: "Get the health and capabilities of the B3nd rig.",
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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "b3nd_receive": {
          const { messages } = args as { messages: [string, unknown][] };
          const results = await rig.receive(messages);
          return {
            content: [{
              type: "text",
              text: JSON.stringify(
                results.map((r, i) => ({ uri: messages[i][0], accepted: r.accepted, error: r.error })),
                null,
                2,
              ),
            }],
            isError: results.some((r) => !r.accepted),
          };
        }

        case "b3nd_read": {
          const { uris } = args as { uris: string | string[] };
          const results = await rig.read(uris);
          return {
            content: [{
              type: "text",
              text: JSON.stringify(
                results.map((r) => r.success ? { uri: r.uri, data: r.record?.data } : { uri: r.uri, error: r.error }),
                null,
                2,
              ),
            }],
            isError: results.every((r) => !r.success),
          };
        }

        case "b3nd_status": {
          const result = await rig.status();
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
        content: [{ type: "text", text: JSON.stringify({ error: message, tool: name }, null, 2) }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    try {
      const status = await rig.status();
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

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resourceUri = request.params.uri;
    const b3ndUri = resourceUri.replace(/^b3nd:\/\//, "");
    try {
      const [result] = await rig.read(b3ndUri);
      return {
        contents: [{
          uri: resourceUri,
          mimeType: "application/json",
          text: JSON.stringify(result.success ? result.record?.data : { error: result.error }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        contents: [{ uri: resourceUri, mimeType: "application/json", text: JSON.stringify({ error: message }) }],
      };
    }
  });

  return server;
}
