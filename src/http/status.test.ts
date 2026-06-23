/// <reference lib="deno.ns" />
/**
 * Regression test: `StatusResult.resources` round-trips through the HTTP service.
 *
 * The HTTP service encodes status via `json(res)` which is a transparent
 * `JSON.stringify` — no field picking. This test locks that in so any
 * future whitelist/pick step that drops `resources` will fail loudly.
 */

import { assertEquals } from "@std/assert";
import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { httpApi } from "./service.ts";

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

function buildRig(): Rig {
  const r = connection(new ResourcesStub(), ["**"]);
  // Wire into all three verbs so the Rig's aggregation lets all three
  // resource prefixes (read, observe, receive) through to the response.
  return new Rig({ routes: { receive: [r], read: [r], observe: [r] } });
}

Deno.test("HTTP status: resources field round-trips through JSON response", async () => {
  const handler = httpApi(buildRig());
  const req = new Request("http://test/api/v1/status", { method: "GET" });
  const res = await handler(req);

  assertEquals(res.status, 200);
  const body = await res.json() as StatusResult;

  assertEquals(body.status, "healthy");
  assertEquals(body.resources, RESOURCES);
  assertEquals(body.resources?.read, ["immutable://open/"]);
  assertEquals(body.resources?.observe, ["immutable://open/"]);
  assertEquals(body.resources?.receive, ["immutable://open/"]);
});

Deno.test("HTTP status: resources field is absent when node does not set it", async () => {
  // Regression guard: if resources is undefined it should not appear in JSON
  // (JSON.stringify omits undefined values). The parsed body should not have
  // a `resources` key rather than having it set to null or {}.
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

  const r = connection(new NoResourcesStub(), ["**"]);
  const rig = new Rig({ routes: { receive: [r], read: [r] } });
  const handler = httpApi(rig);
  const req = new Request("http://test/api/v1/status", { method: "GET" });
  const res = await handler(req);

  assertEquals(res.status, 200);
  const body = await res.json() as StatusResult;

  assertEquals(body.status, "healthy");
  // `resources` must not be present when the node doesn't set it
  assertEquals("resources" in body, false);
});
