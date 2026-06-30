/// <reference lib="deno.ns" />
/**
 * HttpClient: pure unit tests with `fetch` stubbed.
 *
 * Documents the client's surface — request shape (URL, method, headers,
 * body), response decode, error mapping, pre-validation, preSend hook,
 * abort/timeout — without touching the network. Wire-level conformance
 * with the server lives in tests/integration/.
 *
 * Every test installs a fetch spy via the global, captures the
 * outgoing request, and returns whatever Response the assertion needs.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { HttpClient } from "./client.ts";
import { RequestError, TransportError } from "../errors.ts";
import { decodeBytesList } from "../codecs/bytes-list.ts";
import { encodeOutputsFrame } from "../codecs/outputs-frame.ts";
import { decodeUrlList } from "../codecs/url-list.ts";
import { httpOutputsFrame } from "../codecs/http/mod.ts";

const codec = httpOutputsFrame();

interface Captured {
  url: URL;
  method: string;
  headers: Headers;
  body: BodyInit | null;
  signal: AbortSignal | undefined;
}

/**
 * Replace global fetch with a spy that captures the outgoing request
 * and returns whatever the test provides. Returns a `restore` thunk.
 *
 * The spy accepts a function that produces a Response (so tests can
 * branch on the captured request), or throws to simulate network
 * failure. The captured slot exposes the most recent call.
 */
function spyFetch(
  respond: (req: Captured) => Response | Promise<Response>,
): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const captured: Captured = {
      url: input instanceof URL ? input : new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: (init?.body ?? null) as BodyInit | null,
      signal: init?.signal ?? undefined,
    };
    calls.push(captured);
    return Promise.resolve(respond(captured));
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ── status ──

Deno.test("status: GET /api/v1/status, parses JSON body", async () => {
  const { calls, restore } = spyFetch(() =>
    new Response(JSON.stringify({ status: "healthy", message: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
  try {
    const c = new HttpClient({ url: "http://h", codec });
    const s = await c.status();
    assertEquals(s, { status: "healthy", message: "ok" });
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "GET");
    assertEquals(calls[0].url.pathname, "/api/v1/status");
  } finally {
    restore();
  }
});

Deno.test("status: non-OK response → returns unhealthy (does not throw)", async () => {
  const { restore } = spyFetch(() => new Response("oops", { status: 500 }));
  try {
    const s = await new HttpClient({ url: "http://h", codec }).status();
    assertEquals(s.status, "unhealthy");
    assertEquals(s.message, "status check failed: HTTP 500");
  } finally {
    restore();
  }
});

Deno.test("status: network error → returns unhealthy with message", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("ECONNREFUSED"));
  try {
    const s = await new HttpClient({ url: "http://h", codec }).status();
    assertEquals(s.status, "unhealthy");
    assertEquals(
      typeof s.message === "string" && s.message.includes("ECONNREFUSED"),
      true,
    );
  } finally {
    globalThis.fetch = original;
  }
});

// ── read ──

Deno.test("read: empty urls returns [] without fetch", async () => {
  const { calls, restore } = spyFetch(() => new Response("never"));
  try {
    const out = await new HttpClient({ url: "http://h", codec }).read([]);
    assertEquals(out, []);
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

Deno.test("read: POST /api/v1/read?u=<b64> with no body, parses outputs-frame", async () => {
  const expected: [string, unknown][] = [
    ["mutable://x", { a: 1 }],
    ["mutable://y", { b: 2 }],
  ];
  const { calls, restore } = spyFetch((c) => {
    assertEquals(c.method, "POST");
    assertEquals(c.url.pathname, "/api/v1/read");
    assertEquals(c.body, null);
    return new Response(encodeOutputsFrame(expected) as unknown as BodyInit, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    });
  });
  try {
    const out = await new HttpClient({ url: "http://h", codec }).read([
      "mutable://x",
      "mutable://y",
    ]);
    assertEquals(out, expected);
    const u = calls[0].url.searchParams.get("u");
    assertEquals(decodeUrlList(u!), ["mutable://x", "mutable://y"]);
  } finally {
    restore();
  }
});

Deno.test("read: bytes payloads round-trip without JSON mangling", async () => {
  // The bug this fixes: prior JSON response shape mangled Uint8Array
  // payloads into `{"0":1,"1":2,…}` and the client cast them through
  // as if they were still bytes. Pure-bytes responses must come back
  // as `Uint8Array` instances with identical contents.
  const original = new Uint8Array([0, 1, 2, 250, 251, 255]);
  const expected: [string, Uint8Array][] = [["mutable://b", original]];
  const { restore } = spyFetch(() =>
    new Response(encodeOutputsFrame(expected) as unknown as BodyInit, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    })
  );
  try {
    const out = await new HttpClient({ url: "http://h", codec }).read<Uint8Array>([
      "mutable://b",
    ]);
    assertEquals(out.length, 1);
    assertEquals(out[0][0], "mutable://b");
    const payload = out[0][1];
    // Must be raw bytes, not a JSON-mangled object.
    assertEquals(payload instanceof Uint8Array, true);
    assertEquals(Array.from(payload as Uint8Array), Array.from(original));
  } finally {
    restore();
  }
});

Deno.test("read: null payload (miss sentinel) survives the round-trip", async () => {
  const expected: [string, unknown][] = [["mutable://miss", null]];
  const { restore } = spyFetch(() =>
    new Response(encodeOutputsFrame(expected) as unknown as BodyInit, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    })
  );
  try {
    const out = await new HttpClient({ url: "http://h", codec }).read([
      "mutable://miss",
    ]);
    assertEquals(out, [["mutable://miss", null]]);
  } finally {
    restore();
  }
});

Deno.test("read: malformed response body → RequestError with operation=read", async () => {
  const { restore } = spyFetch(() =>
    new Response(new Uint8Array([0xff, 0xff, 0xff]), {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    })
  );
  try {
    const err = await assertRejects(
      () => new HttpClient({ url: "http://h", codec }).read(["mutable://x"]),
      RequestError,
    );
    assertEquals(err.operation, "read");
    assertEquals(err.transport, "http");
  } finally {
    restore();
  }
});

Deno.test("read: non-OK response → throws RequestError with status/body/operation", async () => {
  const { restore } = spyFetch(() =>
    new Response("body text", { status: 404, statusText: "Not Found" })
  );
  try {
    const c = new HttpClient({ url: "http://h", codec });
    const err = await assertRejects(
      () => c.read(["mutable://x"]),
      RequestError,
    );
    assertEquals(err.status, 404);
    assertEquals(err.body, "body text");
    assertEquals(err.operation, "read");
    assertEquals(err.transport, "http");
  } finally {
    restore();
  }
});

Deno.test("read: network error → throws TransportError", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("dns"));
  try {
    const c = new HttpClient({ url: "http://h", codec });
    await assertRejects(() => c.read(["mutable://x"]), TransportError, "dns");
  } finally {
    globalThis.fetch = original;
  }
});

// ── receive ──

Deno.test("receive: empty payload → POST with empty body, returns server results", async () => {
  // The client filters invalid slots; with only valid slots it sends one POST.
  const { calls, restore } = spyFetch((c) => {
    assertEquals(c.method, "POST");
    assertEquals(c.url.pathname, "/api/v1/receive");
    assertEquals(c.headers.get("Content-Type"), "application/octet-stream");
    return new Response(JSON.stringify([{ accepted: true }]), { status: 200 });
  });
  try {
    const out = await new HttpClient({ url: "http://h", codec }).receive([
      ["mutable://x", new Uint8Array([1, 2, 3])],
    ]);
    assertEquals(out, [{ accepted: true }]);
    // Body is bytes-list at lenSize=4 with our single payload.
    const bodyBytes = new Uint8Array(
      await new Response(calls[0].body).arrayBuffer(),
    );
    assertEquals(
      Array.from(decodeBytesList(bodyBytes, { lenSize: 4 })[0]),
      [1, 2, 3],
    );
  } finally {
    restore();
  }
});

Deno.test("receive: non-string URI rejected per-slot, no fetch", async () => {
  const { calls, restore } = spyFetch(() => new Response("never"));
  try {
    const out = await new HttpClient({ url: "http://h", codec }).receive([
      [null as unknown as string, new Uint8Array([1])],
    ]);
    assertEquals(out, [{ accepted: false, error: "Output URI is required" }]);
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

Deno.test("receive: non-Uint8Array payload rejected per-slot, no fetch", async () => {
  const { calls, restore } = spyFetch(() => new Response("never"));
  try {
    const out = await new HttpClient({ url: "http://h", codec }).receive([
      ["mutable://x", { not: "bytes" } as unknown as Uint8Array],
    ]);
    assertEquals(out, [{
      accepted: false,
      error: "Payload must be Uint8Array",
    }]);
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

Deno.test("receive: mixed valid/invalid sends only valid slots, threads results back", async () => {
  const { calls, restore } = spyFetch(() => {
    // Two valid slots reach the server; it returns two results.
    return new Response(
      JSON.stringify([{ accepted: true }, { accepted: false, error: "x" }]),
      { status: 200 },
    );
  });
  try {
    const out = await new HttpClient({ url: "http://h", codec }).receive([
      ["mutable://a", new Uint8Array([1])],
      [null as unknown as string, new Uint8Array([2])], // invalid
      ["mutable://c", new Uint8Array([3])],
    ]);
    assertEquals(out, [
      { accepted: true },
      { accepted: false, error: "Output URI is required" },
      { accepted: false, error: "x" },
    ]);
    assertEquals(calls.length, 1);
    const u = calls[0].url.searchParams.get("u");
    assertEquals(decodeUrlList(u!), ["mutable://a", "mutable://c"]);
  } finally {
    restore();
  }
});

Deno.test("receive: non-OK response → per-slot error with HTTP status message", async () => {
  const { restore } = spyFetch(() =>
    new Response("", { status: 500, statusText: "Internal Server Error" })
  );
  try {
    const out = await new HttpClient({ url: "http://h", codec }).receive([
      ["mutable://x", new Uint8Array([1])],
    ]);
    assertEquals(out, [{
      accepted: false,
      error: "HTTP 500 Internal Server Error",
    }]);
  } finally {
    restore();
  }
});

Deno.test("receive: server returns fewer results than valid slots → fills with sentinel", async () => {
  const { restore } = spyFetch(() =>
    new Response(JSON.stringify([{ accepted: true }]), { status: 200 })
  );
  try {
    const out = await new HttpClient({ url: "http://h", codec }).receive([
      ["mutable://a", new Uint8Array([1])],
      ["mutable://b", new Uint8Array([2])],
    ]);
    assertEquals(out[0], { accepted: true });
    assertEquals(out[1], { accepted: false, error: "No result from server" });
  } finally {
    restore();
  }
});

Deno.test("receive: all-invalid input → no fetch, returns per-slot errors", async () => {
  const { calls, restore } = spyFetch(() => new Response("never"));
  try {
    const out = await new HttpClient({ url: "http://h", codec }).receive([
      [null as unknown as string, new Uint8Array([1])],
    ]);
    assertEquals(calls.length, 0);
    assertEquals(out.length, 1);
    assertEquals(out[0].accepted, false);
  } finally {
    restore();
  }
});

// ── observe ──

Deno.test("observe: empty urls returns without fetch", async () => {
  const { calls, restore } = spyFetch(() => new Response("never"));
  try {
    const c = new HttpClient({ url: "http://h", codec });
    const it = c.observe([], new AbortController().signal);
    for await (const _ of it) { /* nothing */ }
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

Deno.test("observe: streams string[] frames from NDJSON, skips non-array lines", async () => {
  const ndjson = `["a","b"]\n` +
    `{"error":"ignored"}\n` +
    `["c"]\n`;
  const { calls, restore } = spyFetch((c) => {
    assertEquals(c.method, "POST");
    assertEquals(c.url.pathname, "/api/v1/observe");
    return new Response(ndjson, { status: 200 });
  });
  try {
    const frames: string[][] = [];
    const c = new HttpClient({ url: "http://h", codec });
    for await (
      const f of c.observe(["mutable://x"], new AbortController().signal)
    ) {
      frames.push([...f]);
    }
    assertEquals(frames, [["a", "b"], ["c"]]);
    assertEquals(calls.length, 1);
  } finally {
    restore();
  }
});

Deno.test("observe: non-OK response → throws RequestError", async () => {
  const { restore } = spyFetch(() =>
    new Response("nope", { status: 500, statusText: "Server Error" })
  );
  try {
    const c = new HttpClient({ url: "http://h", codec });
    await assertRejects(
      async () => {
        for await (
          const _ of c.observe(["mutable://x"], new AbortController().signal)
        ) { /* drain */ }
      },
      RequestError,
    );
  } finally {
    restore();
  }
});

Deno.test("observe: pre-aborted signal swallows fetch error and returns", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (_input, init) => {
    // Simulate fetch rejecting with AbortError when the supplied signal
    // is already aborted.
    if (init?.signal?.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      return Promise.reject(e);
    }
    return Promise.resolve(new Response(""));
  };
  try {
    const ac = new AbortController();
    ac.abort();
    const c = new HttpClient({ url: "http://h", codec });
    let yields = 0;
    for await (const _ of c.observe(["mutable://x"], ac.signal)) yields++;
    assertEquals(yields, 0);
  } finally {
    globalThis.fetch = original;
  }
});

// ── preSend hook ──

Deno.test("preSend: hook fires before fetch and can mutate headers/url", async () => {
  const { calls, restore } = spyFetch(() =>
    new Response(
      encodeOutputsFrame([["mutable://x", null]]) as unknown as BodyInit,
      { status: 200, headers: { "Content-Type": "application/octet-stream" } },
    )
  );
  try {
    const c = new HttpClient({
      url: "http://h",
      codec,
      preSend: (r) => {
        r.headers.set("Authorization", "Bearer xyz");
        r.url.searchParams.set("traced", "1");
      },
    });
    await c.read(["mutable://x"]);
    assertEquals(calls[0].headers.get("Authorization"), "Bearer xyz");
    assertEquals(calls[0].url.searchParams.get("traced"), "1");
  } finally {
    restore();
  }
});

Deno.test("preSend: async hook is awaited", async () => {
  const { calls, restore } = spyFetch(() =>
    new Response(
      encodeOutputsFrame([["mutable://x", null]]) as unknown as BodyInit,
      { status: 200, headers: { "Content-Type": "application/octet-stream" } },
    )
  );
  try {
    const c = new HttpClient({
      url: "http://h",
      codec,
      preSend: async (r) => {
        await Promise.resolve();
        r.headers.set("x-async", "ok");
      },
    });
    await c.read(["mutable://x"]);
    assertEquals(calls[0].headers.get("x-async"), "ok");
  } finally {
    restore();
  }
});

// ── config ──

Deno.test("config: trailing slash on baseUrl is stripped", async () => {
  const { calls, restore } = spyFetch(() =>
    new Response("{}", { status: 200 })
  );
  try {
    await new HttpClient({ url: "http://h/", codec }).status();
    assertEquals(calls[0].url.toString(), "http://h/api/v1/status");
  } finally {
    restore();
  }
});

Deno.test("config: custom default headers are sent on every request", async () => {
  const { calls, restore } = spyFetch(() =>
    new Response(
      encodeOutputsFrame([["mutable://x", null]]) as unknown as BodyInit,
      { status: 200, headers: { "Content-Type": "application/octet-stream" } },
    )
  );
  try {
    const c = new HttpClient({
      url: "http://h",
      codec,
      headers: { "x-tenant": "acme" },
    });
    await c.read(["mutable://x"]);
    assertEquals(calls[0].headers.get("x-tenant"), "acme");
  } finally {
    restore();
  }
});
