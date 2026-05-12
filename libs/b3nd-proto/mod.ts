/**
 * @module
 * b3nd proto — buf-generated wire types, schemas, and converters.
 *
 * Types in `gen/` are generated from `b3nd.proto`:
 *   npx buf generate libs/b3nd-proto
 *
 * `B3ndService` is the GenService descriptor — pass it to
 * `createClient(B3ndService, createConnectTransport({...}))` from
 * @connectrpc/connect-web for typed unary access in web apps.
 */

export type {
  ObserveRequest,
  OutputProto,
  ReadRequest,
  ReadResponse,
  ReceiveRequest,
  ReceiveResponse,
  ReceiveResultProto,
  StatusRequest,
  StatusResponse,
} from "./gen/b3nd_pb.ts";

export {
  B3ndService,
  ObserveRequestSchema,
  OutputProtoSchema,
  ReadRequestSchema,
  ReadResponseSchema,
  ReceiveRequestSchema,
  ReceiveResponseSchema,
  ReceiveResultProtoSchema,
  StatusRequestSchema,
  StatusResponseSchema,
} from "./gen/b3nd_pb.ts";

export {
  outputFromProto,
  outputToProto,
  receiveResultFromProto,
  receiveResultToProto,
  statusResponseToResult,
  statusResultToResponse,
} from "./convert.ts";
