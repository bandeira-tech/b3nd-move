import { pinContract } from "../mod.ts";
import { grpcHttpInProcess } from "../factories/grpchttp-in-process.ts";

pinContract("grpchttp-json", grpcHttpInProcess({ binary: false }));
pinContract("grpchttp-binary", grpcHttpInProcess({ binary: true }));
