/**
 * HTTP transport conformance — real `httpApi` + real `HttpClient` over a
 * loopback wire against `stubRig`, driven by the shared move suite.
 *
 * The plug (server boot + client build + payload adapter) lives in
 * `_conformance/plug.ts`; `runMovePlug` owns the lifecycle. This file is
 * the co-located entry point — the conformance run lives next to the code
 * it proves, not in a distant `tests/` tree.
 */

/// <reference lib="deno.ns" />

import { runMovePlug } from "../../tests/suites/move-plug.ts";
import { httpPlug } from "./_conformance/plug.ts";

await runMovePlug(httpPlug);
