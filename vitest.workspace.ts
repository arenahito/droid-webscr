import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["**/dist/**"],
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
    projects: ["apps/*/vitest.config.ts", "packages/*/vitest.config.ts"],
  },
});
