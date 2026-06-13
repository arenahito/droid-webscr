import { defineConfig } from "tsup";

import { workspaceAliases } from "../../tools/vitest-workspace-aliases.js";

export default defineConfig({
  clean: true,
  dts: false,
  entry: {
    dev: "src/dev.ts",
  },
  esbuildOptions(options) {
    options.alias = {
      ...options.alias,
      ...workspaceAliases,
    };
  },
  external: ["@fastify/middie", "@fastify/websocket", "fastify", "pino", "vite"],
  format: ["esm"],
  noExternal: [/^@droid-webscr\//],
  platform: "node",
  shims: false,
  sourcemap: true,
  splitting: false,
  target: "node24",
});
