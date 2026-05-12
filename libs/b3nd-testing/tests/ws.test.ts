import { pinContract } from "../mod.ts";
import { wsInProcess } from "../factories/ws-in-process.ts";

pinContract("ws-in-process", wsInProcess);
