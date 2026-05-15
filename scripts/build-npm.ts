#!/usr/bin/env -S deno run -A
// deno-lint-ignore-file no-import-prefix
/**
 * Build an NPM package from the Deno source via @deno/dnt.
 *
 * Output: ./npm/  — published as `@bandeira-tech/b3nd-move` on npm.
 *
 * The npm build ships ONLY the universal slices that run on Node and in
 * browsers:
 *
 *   • `./http/service`       — `httpApi(rig)` (pure fetch handler)
 *   • `./http/client`        — `HttpClient`
 *   • `./grpc/http/service`  — `grpcHttpApi(rig)` (pure fetch handler)
 *   • `./grpc/http/client`   — `GrpcHttpClient`
 *   • `./grpc/proto/types`   — generated wire types + schemas
 *   • `./grpc/proto/convert` — converters between proto and b3nd types
 *
 * The Deno-only slices (`./http/server`, `./ws/server`, `./grpc/http/server`,
 * `./mcp/*`) call `Deno.serve` or speak stdio and stay JSR-only. Node
 * consumers feed `httpApi(rig)` / `grpcHttpApi(rig)` to their own HTTP
 * runtime — Hono, Express, raw `node:http`, Cloudflare Workers, …
 */

import { build, emptyDir } from "jsr:@deno/dnt@^0.42.1";

const denoJson = JSON.parse(await Deno.readTextFile("./deno.json"));
const version = denoJson.version as string;

await emptyDir("./npm");

await build({
  entryPoints: [
    { name: "./http/service", path: "./src/http/service.ts" },
    { name: "./http/client", path: "./src/http/client.ts" },
    { name: "./grpc/http/service", path: "./src/grpc/http/service.ts" },
    { name: "./grpc/http/client", path: "./src/grpc/http/client.ts" },
    { name: "./grpc/proto/types", path: "./src/grpc/proto/gen/b3nd_pb.ts" },
    { name: "./grpc/proto/convert", path: "./src/grpc/proto/convert.ts" },
  ],
  outDir: "./npm",
  shims: { deno: false },
  test: false,
  scriptModule: false,
  // KNOWN LIMITATION (dnt 0.42.x): mappings keyed on the resolved JSR
  // URL trip an internal `dnt bug - Could not find the mapping` panic
  // (verified across the canon and core builds). Until upstream is
  // fixed, b3nd-core's source gets vendored into this npm package
  // (~tens of KB). Functionally identical, slightly larger.
  compilerOptions: {
    target: "ES2022",
    lib: ["ES2022", "DOM", "DOM.Iterable"],
  },
  package: {
    name: "@bandeira-tech/b3nd-move",
    version,
    description: denoJson.description,
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/bandeira-tech/b3nd-move.git",
    },
    bugs: {
      url: "https://github.com/bandeira-tech/b3nd-move/issues",
    },
    homepage: "https://github.com/bandeira-tech/b3nd-move#readme",
    engines: { node: ">=20" },
    sideEffects: false,
    publishConfig: {
      access: "public",
    },
  },
  postBuild() {
    Deno.copyFileSync("LICENSE", "npm/LICENSE");
    Deno.copyFileSync("README.md", "npm/README.md");

    // dnt emits .js but doesn't always populate `types` keys on
    // package.json's exports map. Mirror import → types so Node
    // resolution finds the .d.ts files.
    const pkgPath = "npm/package.json";
    const pkg = JSON.parse(Deno.readTextFileSync(pkgPath));
    for (const [name, entry] of Object.entries(pkg.exports)) {
      const e = entry as { import?: string; types?: string };
      if (e.import && !e.types) {
        e.types = e.import.replace(/\.js$/, ".d.ts");
        pkg.exports[name] = { types: e.types, import: e.import };
      }
    }
    Deno.writeTextFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  },
});

console.log(`\n✔ Built @bandeira-tech/b3nd-move@${version} → ./npm/`);
