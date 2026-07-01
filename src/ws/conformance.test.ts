/**
 * WebSocket transport conformance — real `wsApi` + real `WebSocketClient`
 * over a loopback socket against `stubRig`, driven by the shared move
 * suite. Plug in `_conformance/plug.ts`; lifecycle owned by `runMovePlug`.
 */

/// <reference lib="deno.ns" />

import { runMovePlug } from "../../tests/suites/move-plug.ts";
import { wsPlug } from "./_conformance/plug.ts";

await runMovePlug(wsPlug);
