import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    name: "@droid-webscr/web",
    setupFiles: ["src/test/setup.ts"],
  },
});
