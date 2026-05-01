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
  ReadRequest,
  ReadResponse,
  ReadResultProto,
  ReceiveRequest,
  ReceiveResponse,
  RecordProto,
  StatusRequest,
  StatusResponse,
} from "./gen/b3nd_pb.ts";

export {
  B3ndService,
  ObserveRequestSchema,
  ReadRequestSchema,
  ReadResponseSchema,
  ReadResultProtoSchema,
  ReceiveRequestSchema,
  ReceiveResponseSchema,
  RecordProtoSchema,
  StatusRequestSchema,
  StatusResponseSchema,
} from "./gen/b3nd_pb.ts";

export {
  messageToReceiveRequest,
  readResultFromProto,
  readResultToProto,
  receiveRequestToMessage,
  receiveResponseToResult,
  receiveResultToResponse,
  statusResponseToResult,
  statusResultToResponse,
} from "./convert.ts";
