import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../tools/vitest-workspace-aliases.js";

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    name: "@droid-webscr/web",
    setupFiles: ["src/test/setup.ts"],
  },
});
