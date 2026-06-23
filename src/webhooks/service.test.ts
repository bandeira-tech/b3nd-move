/// <reference lib="deno.ns" />
/**
 * webhooksApi: both directions behind one handler; in/ and out/ prefixes
 * coexist without collision.
 */

import { assertEquals } from "@std/assert";
import { stubRig } from "../../tests/rigs/stub.ts";
import type { Output } from "@bandeira-tech/b3nd-core/types";
import type { WebhookEvent, WebhookSenderConfig } from "./out/sender.ts";
import { webhooksApi } from "./service.ts";
import { decode } from "./in/source.ts";

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://test${path}`, init);
}

Deno.test("inbound and outbound routes coexist under one handler", async () => {
  const events: WebhookEvent[] = [];
  const api = webhooksApi(stubRig(), {
    in: {
      sources: {
        s: { decode: decode.json(() => [["mutable://t/ev", {}]] as Output[]) },
      },
    },
    out: {
      createSender: (_c: WebhookSenderConfig) => (e: WebhookEvent) => {
        events.push(e);
        return Promise.resolve({ ok: true, status: 200, attempts: 1 });
      },
    },
  });

  // Inbound delivery.
  const inRes = await api(req("/api/v1/webhooks/in/s", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }));
  assertEquals(inRes.status, 200);

  // Outbound one-shot read push.
  const outRes = await api(req("/api/v1/webhooks/out/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "http://sink", urls: ["mutable://t/x"] }),
  }));
  assertEquals(outRes.status, 200);
  assertEquals(events[0].type, "read");
});

Deno.test("only inbound configured → outbound paths 404", async () => {
  const api = webhooksApi(stubRig(), {
    in: { sources: { s: { decode: decode.json(() => []) } } },
  });
  const r = await api(
    req("/api/v1/webhooks/out/subscriptions", { method: "GET" }),
  );
  assertEquals(r.status, 404);
});

Deno.test("only outbound configured → inbound paths 404", async () => {
  const api = webhooksApi(stubRig(), { out: {} });
  const r = await api(
    req("/api/v1/webhooks/in/s", { method: "POST", body: "{}" }),
  );
  assertEquals(r.status, 404);
});

Deno.test("empty options → everything 404 (no routes)", async () => {
  const api = webhooksApi(stubRig());
  assertEquals(
    (await api(req("/api/v1/webhooks/in/s", { method: "POST", body: "{}" })))
      .status,
    404,
  );
  assertEquals(
    (await api(req("/api/v1/webhooks/out/subscriptions", { method: "GET" })))
      .status,
    404,
  );
});
