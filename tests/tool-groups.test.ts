import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { DataverseClient } from "../src/client.js";
import { registerAllTools } from "../src/tools/all.js";
import { registerDevelopmentTools } from "../src/tools/development/index.js";
import { SERVER_TOOL_GROUPS } from "../src/tools/server-groups.js";
import type { RegisterTools } from "../src/tools/types.js";

const client = {} as DataverseClient;

function captureTools(register: RegisterTools, allowDelete = false) {
  const shapes = new Map<string, unknown>();
  const server = {
    registerTool: (name: string, config: { inputSchema: unknown }) => {
      shapes.set(name, config.inputSchema);
    },
  };
  register(server as any, { client, allowDelete });
  return shapes;
}

// ADR-0001 §4. The group names are the vocabulary of role configuration, so
// moving a tool between groups is a contract change, not a refactor.
const EXPECTED_GROUPS = {
  "metadata-read": [
    "list_entities",
    "get_entity_schema",
    "get_picklist_options",
    "list_entity_keys",
  ],
  "data-read": ["query_records", "get_record"],
  "data-write": ["create_record", "update_record", "delete_record"],
  actions: ["invoke_action"],
  functions: ["invoke_function"],
  development: [
    "list_solutions",
    "get_attribute_dependencies",
    "create_entity",
    "add_attribute",
    "update_attribute",
    "delete_attribute",
    "create_relationship",
    "add_entity_key",
    "delete_entity_key",
    "add_picklist_option",
    "update_picklist_option",
    "delete_picklist_option",
  ],
};

describe("tool groups", () => {
  it("the server-safe groups are exactly the five non-development groups", () => {
    expect(Object.keys(SERVER_TOOL_GROUPS).sort()).toEqual(
      Object.keys(EXPECTED_GROUPS)
        .filter((g) => g !== "development")
        .sort(),
    );
  });

  for (const [group, register] of Object.entries(SERVER_TOOL_GROUPS)) {
    it(`${group} registers its tools`, () => {
      expect([...captureTools(register).keys()].sort()).toEqual(
        [...EXPECTED_GROUPS[group as keyof typeof EXPECTED_GROUPS]].sort(),
      );
    });
  }

  it("development registers its tools", () => {
    expect([...captureTools(registerDevelopmentTools).keys()].sort()).toEqual(
      [...EXPECTED_GROUPS.development].sort(),
    );
  });

  it("registerAllTools registers every group", () => {
    expect([...captureTools(registerAllTools).keys()].sort()).toEqual(
      Object.values(EXPECTED_GROUPS).flat().sort(),
    );
  });

  // SDK v2 builds a server instance per HTTP request. Input schemas built
  // inside the register functions would be rebuilt every time; module-level
  // shapes are built once and shared.
  // Both modes: the enabled delete tools and their disabled stubs use
  // different shapes.
  for (const allowDelete of [false, true]) {
    it(`input shapes are shared between registrations, not rebuilt (allowDelete: ${allowDelete})`, () => {
      const first = captureTools(registerAllTools, allowDelete);
      const second = captureTools(registerAllTools, allowDelete);
      for (const [name, shape] of first) {
        expect(second.get(name), name).toBe(shape);
      }
    });
  }
});

// A server entry point may import src/tools/server-groups.ts. Nothing reachable from it
// may import src/tools/development/, or the development tools end up in the
// server bundle (ADR-0001 §1). The only way in is src/index.ts (stdio) →
// src/tools/all.ts → development/. #79 adds the bundle-level check in CI.
describe("import boundary", () => {
  const root = resolve(__dirname, "..");

  function localImports(file: string): string[] {
    const source = readFileSync(file, "utf-8");
    const specifiers = [
      // `from "./x.js"`, side-effect `import "./x.js"`, dynamic `import("./x.js")`.
      ...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*"(\.[^"]+)"/g),
    ].map((m) => m[1]);
    return specifiers.map((spec) => {
      const ts = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      if (!existsSync(ts))
        throw new Error(`Unresolved import ${spec} in ${file}`);
      return ts;
    });
  }

  it("nothing reachable from src/tools/server-groups.ts imports development/", () => {
    const seen = new Set<string>();
    const queue = [resolve(root, "src/tools/server-groups.ts")];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      queue.push(...localImports(file));
    }
    const reached = [...seen].map((f) => relative(root, f));
    expect(reached).toContain("src/tools/metadata-read.ts");
    expect(reached.filter((f) => f.includes("/development/"))).toEqual([]);
  });

  function importersOf(): Map<string, string[]> {
    const files = readdirSync(resolve(root, "src"), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => resolve(root, "src", f));
    const importers = new Map<string, string[]>();
    for (const file of files) {
      for (const target of localImports(file)) {
        const key = relative(root, target);
        importers.set(key, [
          ...(importers.get(key) ?? []),
          relative(root, file),
        ]);
      }
    }
    return importers;
  }

  // Guards the entry points themselves, which the reachability check above
  // cannot see: a server entry point importing all.ts or development/ directly
  // fails here.
  it("only src/tools/all.ts imports development/, and only src/index.ts imports all.ts", () => {
    const importers = importersOf();
    const isDevelopment = (f: string) => f.startsWith("src/tools/development/");
    const outsideImporters = new Set(
      [...importers]
        .filter(([target]) => isDevelopment(target))
        .flatMap(([, from]) => from)
        .filter((from) => !isDevelopment(from)),
    );
    expect([...outsideImporters]).toEqual(["src/tools/all.ts"]);
    expect(importers.get("src/tools/all.ts")).toEqual(["src/index.ts"]);
  });
});
