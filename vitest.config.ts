import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary"],
      // About two points below the measured coverage, so noise does not
      // fail a build. Raise these when coverage rises; never lower them.
      thresholds: {
        lines: 90,
        branches: 87,
        functions: 91,
        statements: 89,
      },
    },
  },
});
