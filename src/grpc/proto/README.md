# grpc/proto

Generated protobuf types and the converters that bridge them to b3nd's runtime
types. Consumed by `grpc/http/` on both sides; also useful standalone for web
apps wanting the connect-rpc client.

## Surface

| File                        | Exports                                                                                                                                  | Runtime |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `b3nd.proto`                | wire schema (source of truth)                                                                                                            | —       |
| `gen/b3nd_pb.ts`            | `B3ndService` + `*Schema` descriptors + message types (`ReceiveRequest`, `ReadResponse`, `OutputProto`, `StatusResponse`, …)             | any     |
| `convert.ts`                | `outputToProto`, `outputFromProto`, `receiveResultToProto`, `receiveResultFromProto`, `statusResultToResponse`, `statusResponseToResult` | any     |
| `buf.yaml` / `buf.gen.yaml` | buf codegen config                                                                                                                       | —       |

## Concepts

**Two layers.**

- `gen/b3nd_pb.ts` is the **wire** layer — types and schemas that the protobuf
  runtime understands. Regenerated from `b3nd.proto`.
- `convert.ts` is the **bridge** — pure functions between `b3nd-core`'s runtime
  types (`Output`, `Message`, `ReceiveResult`, `StatusResult`) and the proto
  messages.

`grpc/http/service.ts` and `grpc/http/client.ts` only touch wire types through
`convert.ts`. The rig itself never sees a proto message.

**`B3ndService` descriptor.** A connect-rpc `GenService` — drop it into any
connect-rpc client to talk to a `grpcHttpServer` over JSON unary:

```typescript
import { B3ndService } from "@bandeira-tech/b3nd-move/grpc/proto/types";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

const client = createClient(
  B3ndService,
  createConnectTransport({ baseUrl: "http://localhost:50051" }),
);
```

## Regenerating

```bash
cd src/grpc/proto
npx buf generate
```

Output lands in `src/grpc/proto/gen/`. Lint and format ignore that subtree — see
`deno.json`.

## Notes

- The `.proto`, `buf.yaml`, and `buf.gen.yaml` files are publish-excluded
  (`deno.json#publish.exclude`). Only the generated `.ts` and `convert.ts` ship
  to consumers.
- `bufbuild/es` is the only plugin; it generates both message types and the
  `B3ndService` `GenService` descriptor — no separate `connectrpc/es` plugin
  needed.
