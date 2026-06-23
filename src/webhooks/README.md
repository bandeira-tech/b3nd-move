# webhooks

External HTTP cooperation for B3nd: receive deliveries **in** (drive
`rig.receive`) and push `read` / `observe` results **out** to
consumer-registered callback URLs.

Unlike the request/response transports (`http`, `ws`, `grpc/http`), webhooks are
not a `ProtocolInterfaceNode` client — there's no synchronous round-trip to
pull. The two halves are both _services_: one accepts inbound deliveries, the
other accepts subscriptions and then pushes results outbound on its own
schedule.

```
src/webhooks/
  hmac.ts              shared HMAC-SHA256 sign/verify (Web Crypto)
  service.ts           webhooksApi — both directions, one handler
  in/
    source.ts          WebhookSource contract + verify/decode helpers
    service.ts         webhooksInApi — inbound delivery → rig.receive
  out/
    sender.ts          createWebhookSender — signed, retrying delivery
    bridge.ts          readToWebhook / observeToWebhook — rig → sender
    service.ts         webhooksOutApi — subscription registry + endpoints
```

## Routes

| Method   | Path                                     | Maps to                                  |
| -------- | ---------------------------------------- | ---------------------------------------- |
| `POST`   | `/api/v1/webhooks/in/:source`            | verify → decode → `rig.receive(outputs)` |
| `POST`   | `/api/v1/webhooks/out/subscriptions`     | start `rig.observe` → deliver each frame |
| `GET`    | `/api/v1/webhooks/out/subscriptions`     | list active subscriptions                |
| `DELETE` | `/api/v1/webhooks/out/subscriptions/:id` | cancel a subscription                    |
| `POST`   | `/api/v1/webhooks/out/read`              | `rig.read` once → deliver outputs        |

The `in/` and `out/` prefixes never collide, so `webhooksApi` merges both into a
single dispatch table.

## In — receiving deliveries

One endpoint per _source_ (a sender: GitHub, Stripe, a partner, another B3nd
node). Each source supplies two hooks — the webhooks analogue of
`http-post-content`'s `payloadDecoder`, carrying authenticity and fan-out the
plain POST facet doesn't:

```ts
type WebhookVerify = (ctx: WebhookContext) => void | Promise<void>; // throw Unauthorized to reject
type WebhookDecode = (ctx: WebhookContext) => Output[] | Promise<Output[]>; // one delivery → many outputs
```

```typescript
import { webhooksInApi } from "@bandeira-tech/b3nd-move/webhooks/in/service";
import { decode, verify } from "@bandeira-tech/b3nd-move/webhooks/in/source";

Deno.serve(
  { port: 3000 },
  webhooksInApi(rig, {
    sources: {
      github: {
        verify: verify.hmacSha256({
          secret: GH_SECRET,
          header: "X-Hub-Signature-256",
        }),
        decode: decode.json((e) => [[
          `mutable://gh/${(e as { delivery: string }).delivery}`,
          new TextEncoder().encode(JSON.stringify(e)),
        ]]),
      },
    },
  }),
);
```

| Outcome              | Status                                   |
| -------------------- | ---------------------------------------- |
| receive completes    | `200` with `ReceiveResult[]` (or `ack`)  |
| `verify` throws      | `401` (or the thrown `HttpError` status) |
| `decode` throws      | `400`                                    |
| `rig.receive` throws | `500`                                    |
| unknown `:source`    | `404`                                    |
| non-POST on the path | `405` (`Allow: POST`)                    |

`verify` helpers: `hmacSha256` (default header `X-B3nd-Signature`, prefix
`sha256=`) and `headerToken` (static shared-secret token). `decode.json(map)`
parses the body and hands it to your mapping; custom decoders are just
functions.

## Out — pushing results

A consumer registers a callback URL; results are pushed there instead of held on
an open stream. `observe` subscriptions are long-lived (cancel with `DELETE`);
`read` is a one-shot push.

```typescript
import {
  memoryRegistry,
  webhooksOutApi,
} from "@bandeira-tech/b3nd-move/webhooks/out/service";

const registry = memoryRegistry();
Deno.serve({ port: 3000 }, webhooksOutApi(rig, { registry }));
// on shutdown: registry.closeAll();
```

```
POST /api/v1/webhooks/out/subscriptions
  { "url": "https://consumer/hook", "urls": ["mutable://t/a"], "secret": "…", "hydrate": false }
  → 201 { id, url, urls, hydrate, createdAt }
```

Each fired frame is delivered as `{ type: "observe", id: "<seq>", ts, data }`
where `data` is `{ urls }` — or `{ urls, outputs }` when `hydrate: true` reads
the fired urls first. Deliveries are JSON (not bytes-list framed); a binary read
payload won't survive `JSON.stringify`, so map raw bytes to a JSON-safe shape
upstream before bridging.

### Delivery (`createWebhookSender`)

The outbound counterpart to a transport client: signs the body (HMAC-SHA256, the
same scheme `webhooks/in` verifies — so one B3nd node delivers straight into
another's inbound endpoint), retries transient failures (network, timeout,
`429`, `5xx`) with exponential backoff, and **reports** the outcome rather than
throwing. A non-retriable `4xx` is terminal (the receiver rejected it).

### Bridge

`readToWebhook` and `observeToWebhook` are the engine the service wires up —
usable directly when you want rig→webhook delivery without the subscription HTTP
surface.

## Notes

- **Subscriptions are in-memory by default.** `memoryRegistry()` is per-handler
  and per-process; a deployment with restarts or multiple instances supplies its
  own `SubscriptionRegistry` backed by durable storage. Hosts hold the registry
  to `closeAll()` on shutdown — the move layer never owns a process lifecycle.
- **Runtime binding, CORS, auth, IP allow-listing** are the host's job — wrap
  the returned handler, same as every other service in this package.
- **Signatures use Web Crypto** (`crypto.subtle`), so the module stays universal
  (Deno, Workers, Bun, modern Node) with no `node:crypto` dependency.
