// Checks the packages the MCP SDK inlined into its own dist/ against npm's
// advisories (#130). They reach the server bundle, but package-lock.json has
// no entry for them, so npm audit and Dependabot alerts cannot see them.
//
//   node scripts/audit-inlined.mjs
//
// The names and versions come from the bundle's source map, so a package the
// SDK starts to inline is picked up without a list to edit. Exits 1 on a high
// or critical advisory, like npm audit --audit-level=high, and when it cannot
// tell: no inlined package found, one without a readable version, a registry
// that does not answer, or one that no longer reports an advisory known to
// exist, or reports a severity this script does not know.
// It sees what the source map shows: a dependency that ships its dist/
// without source maps hides whatever it inlined, from this audit and from the
// licence check alike.
// Run by audit.yml on its schedule and by server-release.yml before the image
// is built. Not part of npm run check: a new advisory must not fail an
// unrelated change.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bundleServer, COVERED_BY_SDK, packageOf } from "./build-server.mjs";

/** @typedef {{ name: string, version: string }} InlinedPackage */
/** @typedef {InlinedPackage & { severity: string, title: string, url: string }} Advisory */

// What npm audit itself asks: package names with versions in, the advisories
// that apply to those versions out.
const ADVISORIES_URL =
  "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";

// npm's severities. One it does not know is an error: it must not be read as
// "below high".
const SEVERITIES = new Set(["info", "low", "moderate", "high", "critical"]);
const FAILING_SEVERITIES = new Set(["high", "critical"]);

// A version with several high advisories (GHSA-qw65-cvwx-89v3 and others).
// Asked about first: an endpoint that stopped answering in the expected
// shape would otherwise read as "no advisories" forever. If the registry
// ever withdraws or downgrades all of them, the audit fails on every branch
// until another version known to be vulnerable is put here.
export const CANARY = { name: "fast-uri", version: "3.1.5" };

// What the registry can be asked about. Anything else in the place of a
// version (a git or tarball dependency) would be answered with nothing.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * The packages in the bundle that are not installed from the lockfile: those
 * a dependency had already bundled into its own dist/. The metafile lists
 * what esbuild took from node_modules; the source map also names the files
 * those packages were built from. A source map file is inlined when its
 * package directory is not one esbuild read, so a package that is installed
 * and also inlined, at another version, is still listed.
 *
 * The version is read from the directory pnpm gave the package when the SDK
 * was built (.pnpm/<name>@<version>/node_modules/<name>). A package inlined
 * from any other layout, or with something other than a version there, is an
 * error: it must not pass unaudited.
 *
 * @param {import("esbuild").Metafile} metafile
 * @param {string} sourcemap the source map, as JSON text
 * @returns {InlinedPackage[]} sorted, one entry per name and version
 */
export function inlinedPackages(metafile, sourcemap) {
  // A metafile path is relative to the repo root and a source map path to
  // the output directory: without the leading ../ the two are comparable.
  /** @param {string} dir */
  const fromRoot = (dir) => dir.replace(/^(?:\.\.\/)+/, "");
  const installedDirs = new Set(
    Object.keys(metafile.inputs).flatMap((path) => {
      const installed = packageOf(path);
      return installed ? [fromRoot(installed.dir)] : [];
    }),
  );
  /** @type {Map<string, InlinedPackage>} */
  const found = new Map();
  for (const source of JSON.parse(sourcemap).sources) {
    const origin = packageOf(source);
    if (
      !origin ||
      installedDirs.has(fromRoot(origin.dir)) ||
      COVERED_BY_SDK.has(origin.name)
    ) {
      continue;
    }
    const { name, dir } = origin;
    // pnpm writes a scoped name with + for the slash, and appends the peer
    // dependencies after an underscore: ajv-formats@3.0.1_ajv@8.18.0.
    const storePrefix = `.pnpm/${name.replace("/", "+")}@`;
    const storeSuffix = `/node_modules/${name}`;
    const storeIndex = dir.lastIndexOf(storePrefix);
    const version =
      storeIndex !== -1 && dir.endsWith(storeSuffix)
        ? dir.slice(storeIndex + storePrefix.length, -storeSuffix.length)
        : "";
    const withoutPeers = version.split("_")[0] ?? "";
    if (version.includes("/") || !SEMVER.test(withoutPeers)) {
      throw new Error(
        `cannot read the version of inlined package ${name} from ${source}`,
      );
    }
    found.set(`${name}@${withoutPeers}`, { name, version: withoutPeers });
  }
  return [...found.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

/**
 * The advisories npm has for these packages at these versions.
 *
 * The endpoint answers per package name, not per version. Each request
 * therefore carries a name once: two versions of one package go in two
 * requests, and every advisory is known to apply to the version it is
 * reported for.
 *
 * @param {InlinedPackage[]} packages
 * @param {typeof fetch} [request]
 * @returns {Promise<Advisory[]>}
 */
export async function advisoriesFor(packages, request = fetch) {
  /** @type {Map<string, string>[]} */
  const batches = [];
  for (const { name, version } of packages) {
    let batch = batches.find((versions) => !versions.has(name));
    if (!batch) {
      batch = new Map();
      batches.push(batch);
    }
    batch.set(name, version);
  }
  /** @type {Advisory[]} */
  const advisories = [];
  for (const batch of batches) {
    const response = await request(ADVISORIES_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        Object.fromEntries([...batch].map(([name, v]) => [name, [v]])),
      ),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`the advisory request failed: HTTP ${response.status}`);
    }
    const body = /** @type {unknown} */ (await response.json());
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("the advisory response is not an object");
    }
    for (const [name, list] of Object.entries(body)) {
      const version = batch.get(name);
      if (version === undefined) {
        throw new Error(`the advisory response names ${name}, not asked about`);
      }
      if (!Array.isArray(list)) {
        throw new Error(`the advisory response for ${name} is not a list`);
      }
      for (const { severity, title, url } of list) {
        const level =
          typeof severity === "string" ? severity.toLowerCase() : "";
        if (!SEVERITIES.has(level)) {
          throw new Error(
            `an advisory for ${name} has an unknown severity: ${severity}`,
          );
        }
        advisories.push({
          name,
          version,
          severity: level,
          title: String(title),
          url: String(url),
        });
      }
    }
  }
  return advisories;
}

/**
 * The advisories for these packages, split by whether they fail the audit.
 * Throws when there is nothing to ask about, since the SDK does inline
 * packages and an empty list means they were not found, and when the
 * registry does not report the canary's known advisory.
 *
 * @param {InlinedPackage[]} packages
 * @param {typeof fetch} [request]
 */
export async function auditInlined(packages, request = fetch) {
  if (packages.length === 0) {
    throw new Error(
      "no inlined packages found in the server bundle: the MCP SDK inlines several, so the source map no longer shows them",
    );
  }
  const canary = await advisoriesFor([CANARY], request);
  if (!canary.some(({ severity }) => FAILING_SEVERITIES.has(severity))) {
    throw new Error(
      `the registry reports no high advisory for ${CANARY.name}@${CANARY.version}, which has several: its answers cannot be trusted`,
    );
  }
  const advisories = await advisoriesFor(packages, request);
  const fails = (/** @type {Advisory} */ { severity }) =>
    FAILING_SEVERITIES.has(severity);
  return {
    failing: advisories.filter(fails),
    belowThreshold: advisories.filter((advisory) => !fails(advisory)),
  };
}

async function main() {
  // The version only ends up in the bundle's text, which is thrown away.
  const { metafile, sourcemap } = await bundleServer({ version: "audit" });
  const packages = inlinedPackages(metafile, sourcemap);
  console.log(`Inlined packages in the server bundle: ${packages.length}`);
  for (const { name, version } of packages) console.log(`  ${name}@${version}`);

  const { failing, belowThreshold } = await auditInlined(packages);
  /** @param {Advisory} advisory */
  const formatAdvisory = ({ name, version, severity, title, url }) =>
    `  ${severity}: ${name}@${version}: ${title} (${url})`;
  if (belowThreshold.length > 0) {
    console.log("Advisories below high, not failing:");
    for (const advisory of belowThreshold) {
      console.log(formatAdvisory(advisory));
    }
  }
  if (failing.length > 0) {
    console.error("High or critical advisories in inlined packages:");
    for (const advisory of failing) console.error(formatAdvisory(advisory));
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
