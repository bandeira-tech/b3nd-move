import { pinContract } from "../contract.ts";
import { wsInProcess } from "../factories/ws.ts";

pinContract("ws-in-process", wsInProcess);
