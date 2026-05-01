#!/usr/bin/env -S deno run -A
// deno-lint-ignore-file no-import-prefix
/**
 * Build an NPM package from the Deno source via @deno/dnt.
 *
 * Output: ./npm/  — published as `@bandeira-tech/b3nd-servers` on npm.
 *
 * The npm build ships ONLY the universal slices that run on Node and in
 * browsers:
 *
 *   • `.`                  — composition primitives + `withCors`
 *   • `./grpc/http/api`    — `grpcHttpApi(rig)` (pure (Request) => Response handler)
 *   • `./grpc/http/client` — `GrpcHttpClient`
 *   • `./grpc/proto`       — wire types + converters
 *
 * The Deno-only slices (`./http`, `./grpc/http`, `./grpc/http/server`) call
 * `Deno.serve` and stay JSR-only. Node consumers feed `grpcHttpApi(rig)` (or
 * `httpApi(rig)` from `@bandeira-tech/b3nd-core`) to their own HTTP
 * runtime — Hono, Express, raw `node:http`, Cloudflare Workers, …
 */

import { build, emptyDir } from "jsr:@deno/dnt@^0.42.1";

const denoJson = JSON.parse(await Deno.readTextFile("./deno.json"));
const version = denoJson.version as string;

await emptyDir("./npm");

await build({
  entryPoints: [
    { name: ".", path: "./mod.ts" },
    { name: "./grpc/http/api", path: "./libs/b3nd-server-grpchttp/service.ts" },
    { name: "./grpc/http/client", path: "./libs/b3nd-client-grpchttp/mod.ts" },
    { name: "./grpc/proto", path: "./libs/b3nd-proto/mod.ts" },
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
    name: "@bandeira-tech/b3nd-servers",
    version,
    description: denoJson.description,
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/bandeira-tech/b3nd-servers.git",
    },
    bugs: {
      url: "https://github.com/bandeira-tech/b3nd-servers/issues",
    },
    homepage: "https://github.com/bandeira-tech/b3nd-servers#readme",
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

console.log(`\n✔ Built @bandeira-tech/b3nd-servers@${version} → ./npm/`);
