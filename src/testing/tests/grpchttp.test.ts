import { pinContract } from "../contract.ts";
import { grpcHttpInProcess } from "../factories/grpchttp.ts";

pinContract("grpchttp-json", grpcHttpInProcess({ binary: false }));
pinContract("grpchttp-binary", grpcHttpInProcess({ binary: true }));
