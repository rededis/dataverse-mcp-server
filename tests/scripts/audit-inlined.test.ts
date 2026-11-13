import { beforeAll, describe, expect, it } from "vitest";
import {
  advisoriesFor,
  auditInlined,
  CANARY,
  inlinedPackages,
} from "../../scripts/audit-inlined.mjs";
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
  // Which packages is the SDK's business: an SDK that inlines fewer must not
  // fail npm run check. One that inlines none fails the audit itself, not
  // this test (see "refuses an empty list").
  it("reads a version for whatever the real bundle has inlined, and lists no installed package", () => {
    const packages = inlinedPackages(server.metafile, server.sourcemap);
    const names = packages.map(({ name }) => name);
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

  it("refuses something other than a version in the store path", () => {
    expect(() =>
      inlinedPackages(
        metafile(),
        sourcemap(
          "../node_modules/.pnpm/pkg@github.com+owner+pkg+abc123/node_modules/pkg/a.js",
        ),
      ),
    ).toThrow("cannot read the version of inlined package pkg");
  });

  it("lists a package that is also installed, at its inlined version", () => {
    expect(
      inlinedPackages(
        metafile("node_modules/ajv/dist/ajv.js"),
        sourcemap(
          "../../node_modules/ajv/dist/ajv.js",
          "../../node_modules/node_modules/.pnpm/ajv@6.0.0/node_modules/ajv/lib/ajv.js",
        ),
      ),
    ).toEqual([{ name: "ajv", version: "6.0.0" }]);
  });

  it("reads the version next to the package, not from a store path further out", () => {
    expect(
      inlinedPackages(
        metafile(),
        sourcemap(
          "../node_modules/.pnpm/pkg@1.0.0/node_modules/outer/node_modules/.pnpm/pkg@2.0.0/node_modules/pkg/a.js",
        ),
      ),
    ).toEqual([{ name: "pkg", version: "2.0.0" }]);
  });

  it("knows a package installed inside another one as installed", () => {
    expect(
      inlinedPackages(
        metafile("node_modules/a/node_modules/b/index.js"),
        sourcemap("../../node_modules/a/node_modules/b/index.js"),
      ),
    ).toEqual([]);
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
        if (name === CANARY.name && body[name]?.[0] === CANARY.version) {
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

  it("reports a high advisory as failing, with the package and version", async () => {
    const { request, asked } = registry({ ajv: [high, moderate] });

    const { failing, belowThreshold } = await auditInlined(packages, request);

    expect(failing).toEqual([{ name: "ajv", version: "8.18.0", ...high }]);
    expect(belowThreshold).toEqual([
      { name: "ajv", version: "8.18.0", ...moderate },
    ]);
    expect(asked.at(-1)).toEqual({
      ajv: ["8.18.0"],
      "content-type": ["1.0.5"],
    });
  });

  it("reports a critical advisory as failing", async () => {
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

  it("refuses a request that fails after the canary's answered", async () => {
    const { request: answers } = registry({});
    let calls = 0;
    const request = (async (...args: Parameters<typeof fetch>) => {
      calls += 1;
      return calls === 1
        ? answers(...args)
        : new Response("down", { status: 502 });
    }) as typeof fetch;
    await expect(auditInlined(packages, request)).rejects.toThrow("HTTP 502");
  });

  it("refuses an empty list: the SDK does inline packages", async () => {
    const { request, asked } = registry({});
    await expect(auditInlined([], request)).rejects.toThrow(
      "no inlined packages found",
    );
    expect(asked).toEqual([]);
  });

  it("asks about two versions of one package apart, and reports each for itself", async () => {
    const asked: Record<string, string[]>[] = [];
    const request = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string[]>;
      asked.push(body);
      return new Response(
        JSON.stringify(body.pkg?.[0] === "1.0.0" ? { pkg: [high] } : {}),
      );
    }) as typeof fetch;

    const advisories = await advisoriesFor(
      [
        { name: "pkg", version: "1.0.0" },
        { name: "pkg", version: "2.0.0" },
        { name: "other", version: "3.0.0" },
      ],
      request,
    );

    expect(asked).toEqual([
      { pkg: ["1.0.0"], other: ["3.0.0"] },
      { pkg: ["2.0.0"] },
    ]);
    expect(advisories).toEqual([{ name: "pkg", version: "1.0.0", ...high }]);
  });

  it("refuses an answer about a package it did not ask about", async () => {
    const { request } = registry({});
    const stranger = (async (...args: Parameters<typeof fetch>) => {
      const response = await request(...args);
      const body = (await response.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, stranger: [] }));
    }) as typeof fetch;
    await expect(auditInlined(packages, stranger)).rejects.toThrow(
      "not asked about",
    );
  });

  it("reads a severity in any case", async () => {
    const { request } = registry({ ajv: [{ ...high, severity: "HIGH" }] });
    expect((await auditInlined(packages, request)).failing).toEqual([
      { name: "ajv", version: "8.18.0", ...high },
    ]);
  });

  it("refuses a severity it does not know", async () => {
    const { request } = registry({ ajv: [{ ...high, severity: "severe" }] });
    await expect(auditInlined(packages, request)).rejects.toThrow(
      "unknown severity: severe",
    );
  });

  it("refuses an answer in another shape", async () => {
    const { request } = registry({ ajv: { severity: "high" } });
    await expect(auditInlined(packages, request)).rejects.toThrow(
      "is not a list",
    );
  });
});
