/**
 * @module
 * MCP tool spec — a fixed set of `Deno.test`s exercising the
 * `b3nd_receive` / `b3nd_read` / `b3nd_status` tools end-to-end through
 * a real MCP SDK `Client` connected to a `buildMcpServer(rig)` over
 * `InMemoryTransport`.
 *
 * MCP doesn't fit the PIN-over-network shape (tool calls + JSON text
 * content vs. typed method calls + binary payloads), so this lives
 * alongside `pinContract` rather than reusing it. Each tool gets one
 * round-trip and one shape assertion; the goal is to lock the tool
 * surface that the MCP server exposes today, not to re-prove the rig's
 * behavior.
 */

import { assert, assertEquals } from "@std/assert";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * Factory for an in-process MCP server + connected SDK client.
 *
 * Implementations build a rig, wire it into `buildMcpServer`, link the
 * server and client over `InMemoryTransport`, and return the connected
 * `Client` plus a cleanup hook.
 */
export type McpFactory = () => Promise<{
  client: Client;
  cleanup: () => Promise<void> | void;
}>;

export interface McpSpecOptions {
  sanitizeOps?: boolean;
  sanitizeResources?: boolean;
}

/** Tool call content frames carry text; pull the first text block as a string. */
function firstText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert(Array.isArray(content), "tool result missing content array");
  const block = content.find(
    (c): c is { type: "text"; text: string } =>
      typeof c === "object" && c !== null && "type" in c &&
      (c as { type: unknown }).type === "text" && "text" in c &&
      typeof (c as { text: unknown }).text === "string",
  );
  assert(block !== undefined, "tool result had no text content block");
  return block.text;
}

/**
 * Register the MCP tool spec as a suite of `Deno.test`s. The `label`
 * prefixes every test name so multiple factories (in case we grow them)
 * don't collide.
 */
export function mcpSpec(
  label: string,
  factory: McpFactory,
  options: McpSpecOptions = {},
): void {
  const test = (
    name: string,
    body: (client: Client) => Promise<void>,
  ): void => {
    Deno.test({
      name: `[${label}] ${name}`,
      sanitizeOps: options.sanitizeOps ?? true,
      sanitizeResources: options.sanitizeResources ?? true,
      fn: async () => {
        const { client, cleanup } = await factory();
        try {
          await body(client);
        } finally {
          await cleanup();
        }
      },
    });
  };

  test("listTools exposes the b3nd surface", async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assertEquals(names, ["b3nd_read", "b3nd_receive", "b3nd_status"]);
  });

  test("b3nd_status reports healthy", async (client) => {
    const result = await client.callTool({
      name: "b3nd_status",
      arguments: {},
    });
    const parsed = JSON.parse(firstText(result)) as { status: string };
    assertEquals(parsed.status, "healthy");
  });

  test("b3nd_receive + b3nd_read round-trip a payload", async (client) => {
    const uri = "mutable://mcp-spec/roundtrip";
    const payload = { hello: "mcp", n: 7 };

    const receive = await client.callTool({
      name: "b3nd_receive",
      arguments: { messages: [[uri, payload]] },
    });
    const receiveAck = JSON.parse(firstText(receive)) as Array<
      { uri: string; accepted: boolean; error?: string }
    >;
    assertEquals(receiveAck.length, 1);
    assertEquals(receiveAck[0].uri, uri);
    assertEquals(receiveAck[0].accepted, true);

    const read = await client.callTool({
      name: "b3nd_read",
      arguments: { urls: [uri] },
    });
    const readResults = JSON.parse(firstText(read)) as Array<
      { uri: string; payload: unknown }
    >;
    assertEquals(readResults.length, 1);
    assertEquals(readResults[0].uri, uri);
    assertEquals(readResults[0].payload, payload);
  });

  test("b3nd_read returns one tuple per input url, in order", async (client) => {
    await client.callTool({
      name: "b3nd_receive",
      arguments: {
        messages: [
          ["mutable://mcp-spec/a", "A"],
          ["mutable://mcp-spec/b", "B"],
        ],
      },
    });

    const result = await client.callTool({
      name: "b3nd_read",
      arguments: {
        urls: [
          "mutable://mcp-spec/a",
          "mutable://mcp-spec/missing",
          "mutable://mcp-spec/b",
        ],
      },
    });
    const outputs = JSON.parse(firstText(result)) as Array<
      { uri: string; payload: unknown }
    >;
    assertEquals(outputs.length, 3);
    assertEquals(outputs.map((o) => o.uri), [
      "mutable://mcp-spec/a",
      "mutable://mcp-spec/missing",
      "mutable://mcp-spec/b",
    ]);
    assertEquals(outputs[0].payload, "A");
    assertEquals(outputs[2].payload, "B");
  });
}
