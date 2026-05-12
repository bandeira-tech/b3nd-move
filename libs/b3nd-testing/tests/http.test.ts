import { pinContract } from "../mod.ts";
import { httpInProcess } from "../factories/http-in-process.ts";

// Known upstream resource quirk: core's `httpApi` SSE handler installs
// a 30s keepalive `setInterval` whose `clearInterval` lives in the
// stream's `cancel` callback. Deno's per-test sanitizer fires before
// the server-side stream cancel resolves, so observe tests see a
// false-positive op leak. The fix is upstream — bind the cleanup to
// `req.signal` in `@bandeira-tech/b3nd-core/libs/b3nd-rig/http.ts`.
// Drop `sanitizeOps: false` once that lands.
pinContract("http-in-process", httpInProcess, {
  sanitizeOps: false,
  sanitizeResources: false,
});
