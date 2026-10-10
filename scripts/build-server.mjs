// Builds the HTTP server into one file for the image (#79, ADR-0001 §1):
// build/server/server.js with its source map, the licence texts of the bundled
// packages, and a check that the bundle holds nothing the server must not ship.
//
//   SERVER_VERSION=0.1.0 node scripts/build-server.mjs
//
// Without SERVER_VERSION the server reports the package.json version marked as
// not a release (0.9.0-dev). The server release (#96) passes its server-v* tag.

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTDIR = "build/server";

/**
 * Bundles a server entry point. Without `outdir` nothing is written and the
 * bundle comes back as `code` and `sourcemap`. Metafile paths are relative to the repo root.
 */
export async function bundleServer({
  entryPoint = "src/server/index.ts",
  version,
  external = [],
  outdir,
}) {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: { server: entryPoint },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    sourcemap: true,
    external,
    define: { SERVER_VERSION: JSON.stringify(version) },
    metafile: true,
    logLevel: "warning",
    ...(outdir ? { outdir } : { outdir: "out", write: false }),
  });
  const text = (ext) =>
    result.outputFiles?.find((f) => f.path.endsWith(ext))?.text;
  return {
    metafile: result.metafile,
    code: text(".js"),
    sourcemap: text(".map"),
  };
}

const FORBIDDEN = [
  /^src\/tools\/development\//,
  /^src\/tools\/all\.ts$/,
  /^src\/setup\.ts$/,
  /^src\/index\.ts$/,
  /(^|\/)node_modules\/dotenv\//,
  // The version is injected; reading package.json would ship all of it.
  /^package\.json$/,
];

/** What is wrong with a server bundle, from its metafile; empty if nothing. */
export function bundleProblems(metafile) {
  const problems = Object.keys(metafile.inputs)
    .filter((path) => FORBIDDEN.some((re) => re.test(path)))
    .map((path) => `forbidden module in the server bundle: ${path}`);
  // The image has no node_modules: anything esbuild left external must be
  // part of Node.
  for (const output of Object.values(metafile.outputs)) {
    for (const { path, external } of output.imports) {
      if (external && !isBuiltin(path)) {
        problems.push(`import left for run time, not a Node built-in: ${path}`);
      }
    }
  }
  return [...new Set(problems)];
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice)/i;

/**
 * Where to find the licence texts of every package the bundle holds code
 * from, keyed by package name, and the packages that have none. Bundling
 * copies code but not LICENSE files, which the licences (Apache-2.0, MIT)
 * require to go along with it.
 *
 * Packages come from two places: the metafile lists what esbuild took from
 * node_modules, and the source map also names what those packages had
 * already bundled into their own dist/ (the MCP SDK inlines Ajv and others).
 * Those are not installed, so their texts are kept in scripts/licenses/.
 */
export function licenceTexts(metafile, sourcemap) {
  const dirs = new Map();
  for (const path of Object.keys(metafile.inputs)) {
    const match = path.match(/^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//);
    if (match) dirs.set(match[2], join(ROOT, match[1]));
  }
  for (const source of JSON.parse(sourcemap).sources) {
    const match = source.match(
      /\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)\//,
    );
    if (match && !dirs.has(match[1])) {
      dirs.set(match[1], join(ROOT, "scripts/licenses", match[1]));
    }
  }
  const texts = new Map();
  const missing = [];
  for (const [name, dir] of [...dirs].sort()) {
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => LICENCE_FILE.test(f));
    } catch {}
    if (files.length === 0) missing.push(name);
    else
      texts.set(
        name,
        files.map((f) => join(dir, f)),
      );
  }
  return { texts, missing };
}

function copyLicences(texts, outdir) {
  for (const [name, files] of texts) {
    const target = join(ROOT, outdir, "licenses", name);
    mkdirSync(target, { recursive: true });
    for (const file of files) copyFileSync(file, join(target, basename(file)));
  }
  copyFileSync(join(ROOT, "LICENSE"), join(ROOT, outdir, "LICENSE"));
}

async function main() {
  const { version: packageVersion } = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf-8"),
  );
  const version = process.env.SERVER_VERSION || `${packageVersion}-dev`;
  rmSync(join(ROOT, OUTDIR), { recursive: true, force: true });
  const { metafile } = await bundleServer({ version, outdir: OUTDIR });
  const sourcemap = readFileSync(join(ROOT, OUTDIR, "server.js.map"), "utf-8");
  const { texts, missing } = licenceTexts(metafile, sourcemap);
  const problems = [
    ...bundleProblems(metafile),
    ...missing.map((name) => `no licence text for bundled package ${name}`),
  ];
  if (problems.length > 0) {
    console.error("Server bundle refused:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  copyLicences(texts, OUTDIR);
  console.log(`Built ${OUTDIR}/server.js (version ${version})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
