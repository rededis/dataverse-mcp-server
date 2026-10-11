import { beforeAll, describe, expect, it } from "vitest";
import {
  bundleProblems,
  bundleServer,
  licenceTexts,
} from "../../scripts/build-server.mjs";

const VERSION = "1.2.3-test";

// The server entry point, bundled once for every test that only reads it.
let server: Awaited<ReturnType<typeof bundleServer>>;
beforeAll(async () => {
  server = await bundleServer({ version: VERSION });
});

// The bundle-level half of the import boundary (ADR-0001 §1); the source-level
// half is tests/tool-groups.test.ts. Each sees what the other cannot: esbuild
// drops an unused import, and the source walk cannot see packages or a
// template-literal import().
describe("server bundle check", () => {
  it("passes the server entry point", () => {
    expect(bundleProblems(server.metafile)).toEqual([]);
  });

  it("refuses an entry point that reaches the development tools", async () => {
    const { metafile } = await bundleServer({
      entryPoint: "tests/server/fixtures/leaky-entry.ts",
      version: VERSION,
    });
    const problems = bundleProblems(metafile);
    expect(problems).toContain(
      "forbidden module in the server bundle: src/tools/all.ts",
    );
    expect(problems).toContain(
      "forbidden module in the server bundle: src/tools/development/index.ts",
    );
  });

  it("refuses a package left for run time", async () => {
    const { metafile } = await bundleServer({
      version: VERSION,
      external: ["zod"],
    });
    expect(bundleProblems(metafile)).toContain(
      "import left for run time, not a Node built-in: zod",
    );
  });

  it("reports the injected version, without package.json", () => {
    expect(Object.keys(server.metafile.inputs)).not.toContain("package.json");
    expect(server.code).toContain(`"${VERSION}"`);
  });

  it("refuses to bundle without a version", async () => {
    await expect(bundleServer({})).rejects.toThrow("version is required");
  });
});

describe("server bundle licences", () => {
  it("has a licence text for every package it holds code from", () => {
    const { texts, missing } = licenceTexts(server.metafile, server.sourcemap);
    expect(missing).toEqual([]);
    // Installed packages and the ones the MCP SDK inlined into its own dist/.
    expect([...texts.keys()]).toEqual(
      expect.arrayContaining(["@modelcontextprotocol/server", "zod", "ajv"]),
    );
  });
});
