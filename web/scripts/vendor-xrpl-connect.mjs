import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pre-bundle xrpl-connect into something Rollup can parse.
 *
 * The published xrpl-connect bundle is valid JavaScript -- V8 and esbuild both
 * parse it -- but Rollup's parser rejects it with "Constructor in/after an
 * optional chaining is not allowed" at xrpl-connect.mjs:6803, inside the Xaman
 * payload code. That makes `vite build` fail while `tsc` and the dev server are
 * perfectly happy, which is the worst shape of failure: invisible until deploy.
 *
 * So we run the SDK through esbuild first, targeting es2019 so optional
 * chaining is compiled away entirely and the construct Rollup dislikes cannot
 * survive. vite.config.ts aliases the package to the file this writes.
 *
 * TypeScript is untouched by the alias: `import ... from "xrpl-connect"` still
 * resolves its types from node_modules. Only the bundler is redirected.
 *
 * Runs from web/package.json's `prebuild`, so `npm run build -w web` (which is
 * what Vercel runs) regenerates it. The output is gitignored: it is derived,
 * and committing a 600KB generated blob invites it to drift from the package.
 */

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../src/vendor/xrpl-connect.js");

mkdirSync(dirname(out), { recursive: true });

await build({
  entryPoints: [resolve(here, "../../node_modules/xrpl-connect/xrpl-connect.mjs")],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2019",
  // xrpl stays external: it is a real dependency with its own resolution, and
  // inlining it here would duplicate it in the graph.
  external: ["xrpl"],
  logLevel: "warning",
  legalComments: "none",
});

console.log(`vendored xrpl-connect -> ${out}`);
