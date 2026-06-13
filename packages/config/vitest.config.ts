import { defineConfig } from "vitest/config";
import { workspaceAliases } from "../../tools/vitest-workspace-aliases.js";

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    name: "@droid-webscr/config",
  },
});
