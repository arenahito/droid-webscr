import { defineConfig } from "tsup";

import { workspaceAliases } from "../../tools/vitest-workspace-aliases.js";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    bin: "src/bin.ts",
    index: "src/index.ts",
    main: "src/main.ts",
  },
  external: ["@fastify/websocket", "fastify", "pino"],
  esbuildOptions(options) {
    options.alias = {
      ...options.alias,
      ...workspaceAliases,
    };
  },
  format: ["esm"],
  noExternal: [/^@droid-webscr\//],
  platform: "node",
  shims: false,
  sourcemap: true,
  splitting: false,
  target: "node24",
});
