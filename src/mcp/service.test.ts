// deno-lint-ignore-file no-import-prefix
/// <reference lib="deno.ns" />
/**
 * Regression test: `StatusResult.resources` round-trips through the MCP service.
 *
 * `b3nd_status` serializes via `JSON.stringify(result, null, 2)` — no field
 * picking. This test locks that in so any future whitelist/pick step that drops
 * `resources` will fail loudly.
 *
 * Uses the same `InMemoryTransport` harness pattern as `tests/factories/mcp.ts`
 * and `tests/integration/deno/mcp.test.ts`.
 */

import { assert, assertEquals } from "@std/assert";
import { Client } from "npm:@modelcontextprotocol/sdk@^1.0.0/client/index.js";
import { InMemoryTransport } from "npm:@modelcontextprotocol/sdk@^1.0.0/inMemory.js";
import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { buildMcpServer } from "./service.ts";

const RESOURCES = {
  read: ["immutable://open/"],
  observe: ["immutable://open/"],
  receive: ["immutable://open/"],
};

/** Stub that reports a known `resources` field in its status. */
class ResourcesStub implements ProtocolInterfaceNode {
  receive(msgs: Output[]): Promise<ReceiveResult[]> {
    return Promise.resolve(msgs.map(() => ({ accepted: true })));
  }
  read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
    return Promise.resolve(
      urls.map((u): Output<T> => [u, { echo: u } as unknown as T]),
    );
  }
  // deno-lint-ignore require-yield
  async *observe(): AsyncIterable<readonly string[]> {
    return;
  }
  status(): Promise<StatusResult> {
    return Promise.resolve({
      status: "healthy",
      message: "resources-stub",
      fns: ["receive", "read", "observe", "status"],
      resources: RESOURCES,
    });
  }
}

async function startInProcess(): Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const stub = new ResourcesStub();
  const route = connection(stub, ["**"]);
  // Wire into all three verbs so the Rig's aggregation lets all three
  // resource prefixes (read, observe, receive) through to the response.
  const rig = new Rig({ routes: { receive: [route], read: [route], observe: [route] } });

  const server = buildMcpServer(rig, {
    name: "b3nd-mcp-resources-test",
    version: "0.0.0",
  });
  const client = new Client({
    name: "b3nd-mcp-resources-test-client",
    version: "0.0.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Pull the first text block from a tool result. */
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

Deno.test("MCP b3nd_status: resources field round-trips through JSON text content", async () => {
  const { client, cleanup } = await startInProcess();
  try {
    const result = await client.callTool({ name: "b3nd_status", arguments: {} });
    const parsed = JSON.parse(firstText(result)) as StatusResult;

    assertEquals(parsed.status, "healthy");
    assertEquals(parsed.resources, RESOURCES);
    assertEquals(parsed.resources?.read, ["immutable://open/"]);
    assertEquals(parsed.resources?.observe, ["immutable://open/"]);
    assertEquals(parsed.resources?.receive, ["immutable://open/"]);
  } finally {
    await cleanup();
  }
});

Deno.test("MCP b3nd_status: resources absent when node does not set it", async () => {
  class NoResourcesStub implements ProtocolInterfaceNode {
    receive(msgs: Output[]): Promise<ReceiveResult[]> {
      return Promise.resolve(msgs.map(() => ({ accepted: true })));
    }
    read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
      return Promise.resolve(
        urls.map((u): Output<T> => [u, null as unknown as T]),
      );
    }
    // deno-lint-ignore require-yield
    async *observe(): AsyncIterable<readonly string[]> {
      return;
    }
    status(): Promise<StatusResult> {
      return Promise.resolve({ status: "healthy" });
    }
  }

  const stub = new NoResourcesStub();
  const route = connection(stub, ["**"]);
  const rig = new Rig({ routes: { receive: [route], read: [route] } });

  const server = buildMcpServer(rig, {
    name: "b3nd-mcp-no-resources-test",
    version: "0.0.0",
  });
  const client = new Client({
    name: "b3nd-mcp-no-resources-test-client",
    version: "0.0.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const result = await client.callTool({ name: "b3nd_status", arguments: {} });
    const parsed = JSON.parse(firstText(result)) as StatusResult;

    assertEquals(parsed.status, "healthy");
    assertEquals("resources" in parsed, false);
  } finally {
    await client.close();
    await server.close();
  }
});
