import { beforeAll, describe, expect, it } from "vitest";
import { auditInlined, inlinedPackages } from "../../scripts/audit-inlined.mjs";
import { bundleServer } from "../../scripts/build-server.mjs";

// The audit of what the MCP SDK inlined into its own dist/ (#130). The
// registry is replaced by a function; the real one answers in audit.yml.

let server: Awaited<ReturnType<typeof bundleServer>>;
beforeAll(async () => {
  server = await bundleServer({ version: "1.2.3-test" });
});

/** A metafile with these inputs and nothing else. */
const metafile = (...inputs: string[]) =>
  ({
    inputs: Object.fromEntries(inputs.map((path) => [path, {}])),
    outputs: {},
  }) as unknown as (typeof server)["metafile"];

const sourcemap = (...sources: string[]) => JSON.stringify({ sources });

describe("inlined packages", () => {
  it("lists what the SDK inlined into the real bundle, with versions", () => {
    const packages = inlinedPackages(server.metafile, server.sourcemap);
    const names = packages.map(({ name }) => name);
    expect(names).toEqual(expect.arrayContaining(["ajv", "fast-uri"]));
    // Installed packages are in the lockfile: npm audit has them.
    expect(names).not.toContain("zod");
    expect(names).not.toContain("@modelcontextprotocol/server");
    for (const { name, version } of packages) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it("picks up a package from the source map alone", () => {
    expect(
      inlinedPackages(
        metafile("node_modules/zod/index.js"),
        sourcemap(
          "../../node_modules/zod/index.js",
          "../../src/server/index.ts",
          "../../node_modules/node_modules/.pnpm/newcomer@1.2.3/node_modules/newcomer/index.js",
          "../../node_modules/node_modules/.pnpm/newcomer@1.2.3/node_modules/newcomer/lib/a.js",
        ),
      ),
    ).toEqual([{ name: "newcomer", version: "1.2.3" }]);
  });

  it("reads a scoped name and drops the peer suffix", () => {
    expect(
      inlinedPackages(
        metafile(),
        sourcemap(
          "../node_modules/.pnpm/@scope+pkg@2.0.0-rc.1/node_modules/@scope/pkg/a.js",
          "../node_modules/.pnpm/ajv-formats@3.0.1_ajv@8.18.0/node_modules/ajv-formats/a.js",
        ),
      ),
    ).toEqual([
      { name: "@scope/pkg", version: "2.0.0-rc.1" },
      { name: "ajv-formats", version: "3.0.1" },
    ]);
  });

  it("keeps two versions of one package apart", () => {
    expect(
      inlinedPackages(
        metafile(),
        sourcemap(
          "../node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/a.js",
          "../node_modules/.pnpm/pkg@2.0.0/node_modules/pkg/a.js",
        ),
      ),
    ).toEqual([
      { name: "pkg", version: "1.0.0" },
      { name: "pkg", version: "2.0.0" },
    ]);
  });

  it("refuses an inlined package whose version it cannot read", () => {
    expect(() =>
      inlinedPackages(
        metafile(),
        sourcemap("../../node_modules/vendored/node_modules/pkg/a.js"),
      ),
    ).toThrow("cannot read the version of inlined package pkg");
  });

  it("leaves out the SDK's own workspace package", () => {
    expect(
      inlinedPackages(
        metafile(),
        sourcemap(
          "../../node_modules/@modelcontextprotocol/core-internal/src/a.ts",
        ),
      ),
    ).toEqual([]);
  });
});

describe("inlined package audit", () => {
  const high = { severity: "high", title: "Bad", url: "https://example.com/1" };
  const moderate = {
    severity: "moderate",
    title: "Meh",
    url: "https://example.com/2",
  };

  /**
   * A registry that knows these advisories, and the canary's. Records what
   * it was asked.
   */
  function registry(known: Record<string, unknown>, canary: unknown = [high]) {
    const asked: Record<string, string[]>[] = [];
    const request = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string[]>;
      asked.push(body);
      const answer: Record<string, unknown> = {};
      for (const name of Object.keys(body)) {
        if (name === "fast-uri" && body[name]?.[0] === "3.1.5") {
          answer[name] = canary;
        } else if (name in known) {
          answer[name] = known[name];
        }
      }
      return new Response(JSON.stringify(answer));
    }) as typeof fetch;
    return { request, asked };
  }

  const packages = [
    { name: "ajv", version: "8.18.0" },
    { name: "content-type", version: "1.0.5" },
  ];

  it("fails on a high advisory and names the package and version", async () => {
    const { request, asked } = registry({ ajv: [high, moderate] });

    const { failing, other } = await auditInlined(packages, request);

    expect(failing).toEqual([{ name: "ajv", versions: ["8.18.0"], ...high }]);
    expect(other).toEqual([{ name: "ajv", versions: ["8.18.0"], ...moderate }]);
    expect(asked.at(-1)).toEqual({
      ajv: ["8.18.0"],
      "content-type": ["1.0.5"],
    });
  });

  it("fails on a critical advisory", async () => {
    const { request } = registry({ ajv: [{ ...high, severity: "critical" }] });
    expect((await auditInlined(packages, request)).failing).toHaveLength(1);
  });

  it("passes with advisories below high only", async () => {
    const { request } = registry({ ajv: [moderate] });
    expect((await auditInlined(packages, request)).failing).toEqual([]);
  });

  it("refuses a registry that does not report the canary's advisory", async () => {
    const { request } = registry({}, []);
    await expect(auditInlined(packages, request)).rejects.toThrow(
      "its answers cannot be trusted",
    );
  });

  it("refuses a failed request", async () => {
    const request = (async () =>
      new Response("down", { status: 503 })) as typeof fetch;
    await expect(auditInlined(packages, request)).rejects.toThrow("HTTP 503");
  });

  it("refuses an answer in another shape", async () => {
    const { request } = registry({ ajv: { severity: "high" } });
    await expect(auditInlined(packages, request)).rejects.toThrow(
      "is not a list",
    );
  });
});
