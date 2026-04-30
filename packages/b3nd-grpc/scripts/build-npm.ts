#!/usr/bin/env -S deno run -A
// deno-lint-ignore-file no-import-prefix
/**
 * Build an NPM package from the Deno source via @deno/dnt.
 *
 * Output: ./npm/  — published as `@bandeira-tech/b3nd-grpc`.
 *
 * The npm build ships only the universal slice — `./client`, `./proto`,
 * and `createGrpcHandler` — which run on Node and in browsers. The
 * `./server` subpath (which calls `Deno.serve`) is JSR-only; Node
 * consumers feed `createGrpcHandler(rig)` to their own HTTP/2 server.
 */

import { build, emptyDir } from "jsr:@deno/dnt@^0.42.1";

const denoJson = JSON.parse(await Deno.readTextFile("./deno.json"));
const version = denoJson.version as string;

await emptyDir("./npm");

await build({
  entryPoints: [
    { name: "./client", path: "./client.ts" },
    { name: "./proto", path: "./proto.ts" },
    // ./mod.ts and ./server are JSR-only (server uses Deno.serve).
  ],
  outDir: "./npm",
  shims: { deno: false },
  test: false,
  scriptModule: false,
  compilerOptions: {
    target: "ES2022",
    lib: ["ES2022", "DOM", "DOM.Iterable"],
  },
  // TODO: map @bandeira-tech/b3nd-core to its npm package once published.
  package: {
    name: "@bandeira-tech/b3nd-grpc",
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
    Deno.copyFileSync("../../LICENSE", "npm/LICENSE");
    Deno.copyFileSync("README.md", "npm/README.md");

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

console.log(`\n✔ Built @bandeira-tech/b3nd-grpc@${version} → ./npm/`);
