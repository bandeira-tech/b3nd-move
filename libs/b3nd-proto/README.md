# b3nd-proto

Buf-generated wire types, message schemas, and converters for the B3nd gRPC-HTTP
transport. Universal — no Deno-specific code.

## Codegen

Types in `gen/b3nd_pb.ts` are generated from `b3nd.proto` using
`@bufbuild/protobuf` v2:

```bash
cd libs/b3nd-proto
npx buf generate   # or: bunx buf generate
```

Re-run after editing `b3nd.proto`. The generated file is committed so consumers
don't need buf installed.

## Exports

**Types** (all from `gen/b3nd_pb.ts`): `OutputProto`, `ReceiveRequest`,
`ReceiveResponse`, `ReceiveResultProto`, `ReadRequest`, `ReadResponse`,
`ObserveRequest`, `StatusRequest`, `StatusResponse`

**Schemas** (for use with `@bufbuild/protobuf` `create` / `fromJson` /
`toBinary`): `ReceiveRequestSchema`, `ReadRequestSchema`, `ReadResponseSchema`,
etc.

**`B3ndService`** — `GenService` descriptor for `@connectrpc/connect-web`:

```typescript
import { B3ndService } from "@bandeira-tech/b3nd-servers/grpc/proto";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

const client = createClient(B3ndService, createConnectTransport({ baseUrl }));
```

**Converters** — bridge between b3nd-core types and proto messages:

```typescript
outputToProto<T>(out: Output<T>): OutputProto
outputFromProto<T>(p: OutputProto): Output<T>
receiveResultToProto(r: ReceiveResult): ReceiveResultProto
receiveResultFromProto(r: ReceiveResultProto): ReceiveResult
statusResultToResponse(result: StatusResult): StatusResponse
statusResponseToResult(res: StatusResponse): StatusResult
```
