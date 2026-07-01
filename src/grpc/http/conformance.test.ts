/**
 * gRPC-over-HTTP transport conformance — real `grpcHttpApi` + real
 * `GrpcHttpClient` over a loopback wire against `stubRig`. Runs the shared
 * move suite twice, once per encoding (JSON, binary), so both codec
 * branches are exercised end-to-end. Plugs in `_conformance/plug.ts`.
 */

/// <reference lib="deno.ns" />

import { runMovePlug } from "../../../tests/suites/move-plug.ts";
import { grpcBinaryPlug, grpcJsonPlug } from "./_conformance/plug.ts";

await runMovePlug(grpcJsonPlug);
await runMovePlug(grpcBinaryPlug);
