// Checks the packages the MCP SDK inlined into its own dist/ against npm's
// advisories (#130). They reach the server bundle, but package-lock.json has
// no entry for them, so npm audit and Dependabot alerts cannot see them.
//
//   node scripts/audit-inlined.mjs
//
// The names and versions come from the bundle's source map, so a package the
// SDK starts to inline is picked up without a list to edit. Exits 1 on a high
// or critical advisory, like npm audit --audit-level=high, and when it cannot
// tell: an inlined package without a readable version, a registry that does
// not answer, or one that no longer reports an advisory known to exist.
// Run by audit.yml on its schedule and by server-release.yml before the image
// is built. Not part of npm run check: a new advisory must not fail an
// unrelated change.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bundleServer, COVERED_BY_SDK } from "./build-server.mjs";

/** @typedef {{ name: string, version: string }} InlinedPackage */
/** @typedef {{ name: string, versions: string[], severity: string, title: string, url: string }} Advisory */

// What npm audit itself asks: package names with versions in, the advisories
// that apply to those versions out.
const ADVISORIES_URL =
  "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";

const FAILING = new Set(["high", "critical"]);

// A version with high advisories that will not go away (GHSA-qw65-cvwx-89v3
// and others). Asked about first: an endpoint that stopped answering in the
// expected shape would otherwise read as "no advisories" forever.
const CANARY = { name: "fast-uri", version: "3.1.5" };

/**
 * The packages in the bundle that are not installed from the lockfile: those
 * a dependency had already bundled into its own dist/. The metafile lists
 * what esbuild took from node_modules; the source map also names the files
 * those packages were built from.
 *
 * The version is read from the path pnpm gave the package when the SDK was
 * built (.pnpm/<name>@<version>/node_modules/<name>/). A package inlined
 * from any other layout has no version to read, and that is an error: it
 * must not pass unaudited.
 *
 * @param {import("esbuild").Metafile} metafile
 * @param {string} sourcemap the source map, as JSON text
 * @returns {InlinedPackage[]} sorted, one entry per name and version
 */
export function inlinedPackages(metafile, sourcemap) {
  const installed = new Set();
  for (const path of Object.keys(metafile.inputs)) {
    const name = path.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1];
    if (name) installed.add(name);
  }
  /** @type {Map<string, InlinedPackage>} */
  const found = new Map();
  for (const source of JSON.parse(sourcemap).sources) {
    // The innermost node_modules/ segment is the package the file belongs to.
    const name = [
      ...source.matchAll(/node_modules\/((?:@[^/]+\/)?[^/.][^/]*)\//g),
    ].at(-1)?.[1];
    if (!name || installed.has(name) || COVERED_BY_SDK.has(name)) continue;
    // pnpm writes a scoped name with + for the slash, and appends the peer
    // dependencies after an underscore: ajv-formats@3.0.1_ajv@8.18.0.
    const store = `.pnpm/${name.replace("/", "+")}@`;
    const at = source.lastIndexOf(store);
    const version =
      at === -1
        ? undefined
        : source.slice(at + store.length).match(/^[^/_]+/)?.[0];
    if (!version || !source.includes(`/node_modules/${name}/`, at)) {
      throw new Error(
        `cannot read the version of inlined package ${name} from ${source}`,
      );
    }
    found.set(`${name}@${version}`, { name, version });
  }
  return [...found.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

/**
 * The advisories npm has for these packages at these versions.
 *
 * @param {InlinedPackage[]} packages
 * @param {typeof fetch} [request]
 * @returns {Promise<Advisory[]>}
 */
export async function advisoriesFor(packages, request = fetch) {
  /** @type {Record<string, string[]>} */
  const versions = {};
  for (const { name, version } of packages) {
    versions[name] = [...(versions[name] ?? []), version];
  }
  if (packages.length === 0) return [];
  const response = await request(ADVISORIES_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(versions),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`the advisory request failed: HTTP ${response.status}`);
  }
  const body = /** @type {unknown} */ (await response.json());
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("the advisory response is not an object");
  }
  /** @type {Advisory[]} */
  const advisories = [];
  for (const [name, list] of Object.entries(body)) {
    if (!Array.isArray(list)) {
      throw new Error(`the advisory response for ${name} is not a list`);
    }
    for (const { severity, title, url } of list) {
      if (typeof severity !== "string") {
        throw new Error(`an advisory for ${name} has no severity`);
      }
      advisories.push({
        name,
        versions: versions[name] ?? [],
        severity,
        title: String(title),
        url: String(url),
      });
    }
  }
  return advisories;
}

/**
 * The advisories for these packages, split by whether they fail the audit.
 * Throws when the registry does not report the canary's known advisory.
 *
 * @param {InlinedPackage[]} packages
 * @param {typeof fetch} [request]
 */
export async function auditInlined(packages, request = fetch) {
  const canary = await advisoriesFor([CANARY], request);
  if (!canary.some(({ severity }) => FAILING.has(severity))) {
    throw new Error(
      `the registry reports no high advisory for ${CANARY.name}@${CANARY.version}, which has several: its answers cannot be trusted`,
    );
  }
  const advisories = await advisoriesFor(packages, request);
  return {
    failing: advisories.filter(({ severity }) => FAILING.has(severity)),
    other: advisories.filter(({ severity }) => !FAILING.has(severity)),
  };
}

async function main() {
  // The version only ends up in the bundle's text, which is thrown away.
  const { metafile, sourcemap } = await bundleServer({ version: "audit" });
  const packages = inlinedPackages(metafile, sourcemap);
  // DELIBERATE, to be reverted (#130): an old version with high advisories.
  for (const p of packages) if (p.name === "fast-uri") p.version = "3.1.5";
  console.log(`Inlined packages in the server bundle: ${packages.length}`);
  for (const { name, version } of packages) console.log(`  ${name}@${version}`);

  const { failing, other } = await auditInlined(packages);
  /** @param {Advisory} advisory */
  const line = ({ name, versions, severity, title, url }) =>
    `  ${severity}: ${name}@${versions.join(", ")}: ${title} (${url})`;
  if (other.length > 0) {
    console.log("Advisories below high, not failing:");
    for (const advisory of other) console.log(line(advisory));
  }
  if (failing.length > 0) {
    console.error("High or critical advisories in inlined packages:");
    for (const advisory of failing) console.error(line(advisory));
    console.error(
      "They change only with the MCP SDK: update @modelcontextprotocol/server, or see whether the SDK has a release with the fix.",
    );
    process.exit(1);
  }
  console.log("No high or critical advisories.");
}

// Node resolves symlinks in import.meta.url but not in argv[1] (see
// build-server.mjs).
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
