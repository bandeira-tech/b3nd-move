/**
 * gRPC-HTTP — in-Deno integration: real `grpcHttpApi` + real
 * `GrpcHttpClient` against a `MemoryStore`-backed rig. Registers the
 * contract twice so JSON and binary share assertions but exercise
 * different codec branches.
 */

/// <reference lib="deno.ns" />

import { pinContract } from "../../suites/pin-contract.ts";
import { startGrpcServer } from "../../factories/grpc.ts";
import { memoryRig } from "../../rigs/memory.ts";
import { GrpcHttpClient } from "../../../src/grpc/http/client.ts";

function register(label: string, binary: boolean): void {
  pinContract(label, async () => {
    const server = await startGrpcServer(memoryRig());
    const client = new GrpcHttpClient({ url: server.url, binary });
    return { client, cleanup: () => Promise.resolve(server.stop()) };
  });
}

register("grpc-json", false);
register("grpc-binary", true);
