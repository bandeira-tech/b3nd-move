/// <reference lib="deno.ns" />
/**
 * GrpcHttpClient: pure unit tests with `fetch` stubbed.
 *
 * Documents the client's surface — RPC URL, Content-Type negotiation
 * (json vs proto), request body encoding (toJson / toBinary), response
 * decode, error mapping, observe NDJSON parsing, preSend hook — all
 * without touching the network. Wire-level conformance lives in
 * tests/integration/.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  create,
  fromJson as pbFromJson,
  toBinary as pbToBinary,
  toJson as pbToJson,
} from "@bufbuild/protobuf";
import {
  ObserveFrameSchema,
  ReadResponseSchema,
  ReceiveRequestSchema,
  ReceiveResponseSchema,
  StatusResponseSchema,
} from "./../proto/gen/b3nd_pb.ts";
import { GrpcHttpClient } from "./client.ts";
import { EncodingError, RequestError, TransportError } from "../../errors.ts";
import { grpcProto } from "../../codecs/grpc/mod.ts";

const codec = grpcProto();

const PREFIX = "/b3nd.v1.B3ndService/";

interface Captured {
  url: URL;
  headers: Headers;
  body: BodyInit | null;
  signal: AbortSignal | undefined;
}

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

// ── Status ──

Deno.test("status (json): POSTs to SERVICE_PREFIX+Status with application/json", async () => {
  const respJson = pbToJson(
    StatusResponseSchema,
    create(StatusResponseSchema, { status: "healthy" }),
  );
  const { calls, restore } = spyFetch(() =>
    new Response(JSON.stringify(respJson), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
  try {
    const s = await new GrpcHttpClient({ url: "http://h", codec }).status();
    assertEquals(s.status, "healthy");
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url.pathname, `${PREFIX}Status`);
    assertEquals(calls[0].headers.get("Content-Type"), "application/json");
  } finally {
    restore();
  }
});

Deno.test("status (binary): Content-Type application/proto, request+response binary", async () => {
  const bin = pbToBinary(
    StatusResponseSchema,
    create(StatusResponseSchema, { status: "healthy" }),
  );
  const { calls, restore } = spyFetch(() =>
    new Response(bin, {
      status: 200,
      headers: { "Content-Type": "application/proto" },
    })
  );
  try {
    const s = await new GrpcHttpClient({ url: "http://h", codec, binary: true })
      .status();
    assertEquals(s.status, "healthy");
    assertEquals(calls[0].headers.get("Content-Type"), "application/proto");
  } finally {
    restore();
  }
});

// ── Read ──

Deno.test("read: empty urls returns [] without fetch", async () => {
  const { calls, restore } = spyFetch(() => new Response("never"));
  try {
    const out = await new GrpcHttpClient({ url: "http://h", codec }).read([]);
    assertEquals(out, []);
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

Deno.test("read (json): POSTs Read RPC, parses ReadResponse, returns Output[]", async () => {
  const respJson = pbToJson(
    ReadResponseSchema,
    create(ReadResponseSchema, {
      results: [
        {
          uri: "mutable://x",
          payload: new TextEncoder().encode(JSON.stringify({ v: 1 })),
          payloadIsBinary: false,
        },
      ],
    }),
  );
  const { calls, restore } = spyFetch(() =>
    new Response(JSON.stringify(respJson), { status: 200 })
  );
  try {
    const out = await new GrpcHttpClient({ url: "http://h", codec }).read([
      "mutable://x",
    ]);
    assertEquals(calls[0].url.pathname, `${PREFIX}Read`);
    assertEquals(out, [["mutable://x", { v: 1 }]]);
  } finally {
    restore();
  }
});

Deno.test("read: non-OK response → RequestError with status/body/operation", async () => {
  const { restore } = spyFetch(() =>
    new Response(JSON.stringify({ error: "boom" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  );
  try {
    const c = new GrpcHttpClient({ url: "http://h", codec });
    const err = await assertRejects(
      () => c.read(["mutable://x"]),
      RequestError,
    );
    assertEquals(err.status, 500);
    assertEquals(err.operation, "Read");
    assertEquals(err.transport, "grpc-http");
  } finally {
    restore();
  }
});

// ── Receive ──

Deno.test("receive: empty msgs → returns [] without fetch", async () => {
  const { calls, restore } = spyFetch(() => new Response("never"));
  try {
    const out = await new GrpcHttpClient({ url: "http://h", codec }).receive(
      [],
    );
    assertEquals(out, []);
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

Deno.test("receive (json): sends ReceiveRequest JSON, returns ReceiveResult[]", async () => {
  const respJson = pbToJson(
    ReceiveResponseSchema,
    create(ReceiveResponseSchema, {
      results: [{ accepted: true }],
    }),
  );
  const { calls, restore } = spyFetch(async (c) => {
    // Body should be a valid ReceiveRequest JSON envelope.
    const parsed = JSON.parse(await new Response(c.body).text());
    // toJson uses camelCase or proto-name; both have `messages`.
    pbFromJson(ReceiveRequestSchema, parsed);
    return new Response(JSON.stringify(respJson), { status: 200 });
  });
  try {
    const out = await new GrpcHttpClient({ url: "http://h", codec }).receive([
      ["mutable://x", { v: 1 }],
    ]);
    assertEquals(out, [{ accepted: true }]);
    assertEquals(calls[0].url.pathname, `${PREFIX}Receive`);
  } finally {
    restore();
  }
});

Deno.test("receive: network error → TransportError", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("dns"));
  try {
    const c = new GrpcHttpClient({ url: "http://h", codec });
    await assertRejects(
      () => c.receive([["mutable://x", { v: 1 }]]),
      TransportError,
      "dns",
    );
  } finally {
    globalThis.fetch = original;
  }
});

// ── Observe ──

Deno.test("observe: empty urls returns without fetch", async () => {
  const { calls, restore } = spyFetch(() => new Response("never"));
  try {
    const c = new GrpcHttpClient({ url: "http://h", codec });
    for await (const _ of c.observe([], new AbortController().signal)) {
      /* drain */
    }
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

Deno.test("observe: streams uris from ObserveFrame JSON lines", async () => {
  const frame1 = JSON.stringify(
    pbToJson(ObserveFrameSchema, create(ObserveFrameSchema, { uris: ["a"] })),
  );
  const frame2 = JSON.stringify(
    pbToJson(
      ObserveFrameSchema,
      create(ObserveFrameSchema, { uris: ["b", "c"] }),
    ),
  );
  const { calls, restore } = spyFetch(() =>
    new Response(`${frame1}\n${frame2}\n`, { status: 200 })
  );
  try {
    const frames: string[][] = [];
    for await (
      const f of new GrpcHttpClient({ url: "http://h", codec }).observe(
        ["mutable://x"],
        new AbortController().signal,
      )
    ) {
      frames.push([...f]);
    }
    assertEquals(frames, [["a"], ["b", "c"]]);
    assertEquals(calls[0].url.pathname, `${PREFIX}Observe`);
    assertEquals(calls[0].headers.get("Content-Type"), "application/json");
  } finally {
    restore();
  }
});

Deno.test("observe: server `{ error }` envelope → throws RequestError", async () => {
  const { restore } = spyFetch(() =>
    new Response(`${JSON.stringify({ error: "boom" })}\n`, { status: 200 })
  );
  try {
    const c = new GrpcHttpClient({ url: "http://h", codec });
    await assertRejects(
      async () => {
        for await (
          const _ of c.observe(["mutable://x"], new AbortController().signal)
        ) {
          /* drain */
        }
      },
      RequestError,
      "boom",
    );
  } finally {
    restore();
  }
});

Deno.test("observe: malformed JSON line → throws EncodingError", async () => {
  const { restore } = spyFetch(() =>
    new Response(`not-json\n`, { status: 200 })
  );
  try {
    const c = new GrpcHttpClient({ url: "http://h", codec });
    await assertRejects(
      async () => {
        for await (
          const _ of c.observe(["mutable://x"], new AbortController().signal)
        ) {
          /* drain */
        }
      },
      EncodingError,
    );
  } finally {
    restore();
  }
});

Deno.test("observe: caller-aborted signal exits cleanly (no throw)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (_input, init) => {
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
    let yields = 0;
    for await (
      const _ of new GrpcHttpClient({ url: "http://h", codec }).observe([
        "mutable://x",
      ], ac.signal)
    ) {
      yields++;
    }
    assertEquals(yields, 0);
  } finally {
    globalThis.fetch = original;
  }
});

// ── preSend ──

Deno.test("preSend: hook can mutate headers and url on unary RPCs", async () => {
  const respJson = pbToJson(
    StatusResponseSchema,
    create(StatusResponseSchema, { status: "healthy" }),
  );
  const { calls, restore } = spyFetch(() =>
    new Response(JSON.stringify(respJson), { status: 200 })
  );
  try {
    const c = new GrpcHttpClient({
      url: "http://h",
      codec,
      preSend: (r) => {
        r.headers.set("Authorization", "Bearer x");
        r.url.searchParams.set("traced", "1");
      },
    });
    await c.status();
    assertEquals(calls[0].headers.get("Authorization"), "Bearer x");
    assertEquals(calls[0].url.searchParams.get("traced"), "1");
  } finally {
    restore();
  }
});

// ── config ──

Deno.test("config: trailing slash on baseUrl is stripped", async () => {
  const respJson = pbToJson(
    StatusResponseSchema,
    create(StatusResponseSchema, { status: "healthy" }),
  );
  const { calls, restore } = spyFetch(() =>
    new Response(JSON.stringify(respJson), { status: 200 })
  );
  try {
    await new GrpcHttpClient({ url: "http://h/", codec }).status();
    assertEquals(calls[0].url.toString(), `http://h${PREFIX}Status`);
  } finally {
    restore();
  }
});
