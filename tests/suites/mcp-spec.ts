/**
 * @module
 * MCP tool spec — `Deno.test`s exercising the `b3nd_receive` /
 * `b3nd_read` / `b3nd_status` tools end-to-end through a real MCP
 * SDK `Client` connected to a `buildMcpServer(rig)` over
 * `InMemoryTransport`.
 *
 * MCP doesn't fit the PIN-over-network shape (tool calls + JSON text
 * content vs. typed method calls + binary payloads), so it has its
 * own suite. Each tool is exercised with a batch and the suite asserts
 * shape + slot ordering, mirroring the `moveSuite` conventions:
 * URIs containing `/__reject__/` are rejected by the stub program;
 * URIs containing `/__miss__/` return null payloads.
 *
 * The goal is to lock the tool surface that the MCP server exposes
 * today and prove the wire shape end-to-end — storage round-trip is
 * not asserted, that's `@bandeira-tech/b3nd-stores`'s concern.
 */

import { assert, assertEquals } from "@std/assert";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * Factory for an in-process MCP server + connected SDK client.
 *
 * Implementations build a rig, wire it into `buildMcpServer`, link the
 * server and client over `InMemoryTransport`, and return the connected
 * `Client` plus a cleanup hook. Called fresh per test.
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
 * prefixes every test name so multiple factories don't collide.
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
    const names = (tools as Array<{ name: string }>).map((t) => t.name).sort();
    assertEquals(names, ["b3nd_read", "b3nd_receive", "b3nd_status"]);
  });

  test("b3nd_status reports healthy with fns advertised", async (client) => {
    const result = await client.callTool({
      name: "b3nd_status",
      arguments: {},
    });
    const parsed = JSON.parse(firstText(result)) as {
      status: string;
      fns?: string[];
    };
    assertEquals(parsed.status, "healthy");
    assertEquals(Array.isArray(parsed.fns), true);
  });

  test(
    "b3nd_receive: 5-message batch with mixed accept/reject, slot ordering",
    async (client) => {
      const messages: [string, unknown][] = [
        ["mutable://t/mcp-recv/a", { v: 1 }],
        ["mutable://t/mcp-recv/__reject__/b", { v: 2 }],
        ["mutable://t/mcp-recv/c", { v: 3 }],
        ["mutable://t/mcp-recv/__reject__/d", { v: 4 }],
        ["mutable://t/mcp-recv/e", { v: 5 }],
      ];
      const result = await client.callTool({
        name: "b3nd_receive",
        arguments: { messages },
      });
      const acks = JSON.parse(firstText(result)) as Array<{
        uri: string;
        accepted: boolean;
        error?: string;
      }>;
      assertEquals(acks.length, messages.length);
      assertEquals(acks.map((a) => a.uri), messages.map((m) => m[0]));
      assertEquals(acks.map((a) => a.accepted), [
        true,
        false,
        true,
        false,
        true,
      ]);
    },
  );

  test(
    "b3nd_read: 5-url batch with mixed hit/miss, slot ordering",
    async (client) => {
      const urls = [
        "mutable://t/mcp-read/a",
        "mutable://t/mcp-read/__miss__/b",
        "mutable://t/mcp-read/c",
        "mutable://t/mcp-read/__miss__/d",
        "mutable://t/mcp-read/e",
      ];
      const result = await client.callTool({
        name: "b3nd_read",
        arguments: { urls },
      });
      const outputs = JSON.parse(firstText(result)) as Array<{
        uri: string;
        payload: unknown;
      }>;
      assertEquals(outputs.length, urls.length);
      assertEquals(outputs.map((o) => o.uri), urls);
      assertEquals(outputs[0].payload, { echo: urls[0] });
      assertEquals(outputs[1].payload == null, true);
      assertEquals(outputs[2].payload, { echo: urls[2] });
      assertEquals(outputs[3].payload == null, true);
      assertEquals(outputs[4].payload, { echo: urls[4] });
    },
  );
}
