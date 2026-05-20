/// <reference lib="deno.ns" />
/**
 * httpGetContentApi: routing, hook dispatch, composable helpers.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { httpGetContentApi } from "./service.ts";
import { payloadResponseMap as map } from "./payload-response-map.ts";

class StubBackend implements ProtocolInterfaceNode {
  receive(msgs: Output[]): Promise<ReceiveResult[]> {
    return Promise.resolve(msgs.map(() => ({ accepted: true })));
  }
  read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
    return Promise.resolve(urls.map((url): Output<T> => {
      if (url.includes("/__miss__/")) return [url, null as unknown as T];
      if (url.endsWith(".png")) {
        return [url, {
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          kind: "image",
        } as unknown as T];
      }
      if (url.endsWith(".txt")) {
        return [url, { text: "hello", kind: "text" } as unknown as T];
      }
      return [url, { echo: url, kind: "obj" } as unknown as T];
    }));
  }
  // deno-lint-ignore require-yield
  async *observe(): AsyncIterable<readonly string[]> {
    return;
  }
  status(): Promise<StatusResult> {
    return Promise.resolve({ status: "healthy" });
  }
}

function buildRig(): Rig {
  const route = connection(new StubBackend(), ["*"]);
  return new Rig({ routes: { receive: [route], read: [route] } });
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://test${path}`, init);
}

Deno.test("non-GET → 405", async () => {
  const api = httpGetContentApi(buildRig(), {
    payloadResponseMap: map.json(),
  });
  const r = await api(
    req("/api/v1/content/mutable%3A%2F%2Fapp%2Fx", { method: "POST" }),
  );
  assertEquals(r.status, 405);
  assertEquals(r.headers.get("Allow"), "GET");
});

Deno.test("path outside prefix → 404", async () => {
  const api = httpGetContentApi(buildRig(), {
    payloadResponseMap: map.json(),
  });
  const r = await api(req("/other/thing"));
  assertEquals(r.status, 404);
});

Deno.test("empty URI after prefix → 404", async () => {
  const api = httpGetContentApi(buildRig(), {
    payloadResponseMap: map.json(),
  });
  const r = await api(req("/api/v1/content/"));
  assertEquals(r.status, 404);
});

Deno.test("json() — default JSON response", async () => {
  const api = httpGetContentApi(buildRig(), {
    payloadResponseMap: map.json(),
  });
  const uri = "mutable://app/thing";
  const r = await api(req(`/api/v1/content/${encodeURIComponent(uri)}`));
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("Content-Type"), "application/json");
  assertEquals(await r.json(), { echo: uri, kind: "obj" });
});

Deno.test("byExtension + fromField — png bytes with image/png", async () => {
  const api = httpGetContentApi(buildRig(), {
    payloadResponseMap: map.byExtension({
      png: map.fromField("bytes", { contentType: "image/png" }),
      "*": map.json(),
    }),
  });
  const uri = "mutable://app/icon.png";
  const r = await api(req(`/api/v1/content/${encodeURIComponent(uri)}`));
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("Content-Type"), "image/png");
  const bytes = new Uint8Array(await r.arrayBuffer());
  assertEquals(bytes, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
});

Deno.test("byExtension fallback to '*'", async () => {
  const api = httpGetContentApi(buildRig(), {
    payloadResponseMap: map.byExtension({
      png: map.fromField("bytes", { contentType: "image/png" }),
      "*": map.json(),
    }),
  });
  const uri = "mutable://app/plain";
  const r = await api(req(`/api/v1/content/${encodeURIComponent(uri)}`));
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("Content-Type"), "application/json");
});

Deno.test("byPayloadField — select by payload.kind", async () => {
  const api = httpGetContentApi(buildRig(), {
    payloadResponseMap: map.byPayloadField("kind", {
      image: map.fromField("bytes", { contentType: "image/png" }),
      text: map.fromField("text", { contentType: "text/plain" }),
      "*": map.json(),
    }),
  });
  const r = await api(
    req(`/api/v1/content/${encodeURIComponent("mutable://app/note.txt")}`),
  );
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("Content-Type"), "text/plain");
  assertEquals(await r.text(), "hello");
});

Deno.test("hook throw → 500 with the hook's message", async () => {
  const api = httpGetContentApi(buildRig(), {
    payloadResponseMap: map.fromField("missing", { contentType: "image/png" }),
  });
  const r = await api(
    req(`/api/v1/content/${encodeURIComponent("mutable://app/thing")}`),
  );
  assertEquals(r.status, 500);
  // The hook's error message reaches the body unwrapped — no envelope,
  // no "payloadResponseMap failed:" prefix.
  assertStringIncludes(await r.text(), "field(missing)");
});

Deno.test("fixed() — host-pinned response, miss → 404 policy", async () => {
  const api = httpGetContentApi(buildRig(), {
    payloadResponseMap: async (req, output) => {
      if (output[1] == null) {
        return { body: "gone", status: 404 };
      }
      return await map.json()(req, output);
    },
  });
  const uri = "mutable://app/__miss__/x";
  const r = await api(req(`/api/v1/content/${encodeURIComponent(uri)}`));
  assertEquals(r.status, 404);
  assertEquals(await r.text(), "gone");
});
