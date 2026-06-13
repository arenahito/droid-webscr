import { defineConfig } from "tsup";

import { workspaceAliases } from "../../tools/vitest-workspace-aliases.js";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    bin: "src/bin.ts",
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
