import { pinContract } from "../mod.ts";
import { httpInProcess } from "../factories/http-in-process.ts";

pinContract("http-in-process", httpInProcess);
