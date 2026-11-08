import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // The entry points run only as child processes in the tests, which
      // v8 coverage in the test process does not see.
      exclude: ["src/index.ts", "src/server/index.ts"],
      reporter: [["text", { skipFull: true }], "text-summary"],
      // About two points below the measured coverage, so noise does not
      // fail a build. Raise these when coverage rises; never lower them.
      thresholds: {
        lines: 95,
        branches: 89,
        functions: 96,
        statements: 95,
      },
    },
  },
});
