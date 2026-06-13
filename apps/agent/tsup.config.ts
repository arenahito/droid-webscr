import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    bin: "src/bin.ts",
    index: "src/index.ts",
    main: "src/main.ts",
  },
  external: ["@fastify/websocket", "fastify", "pino"],
  format: ["esm"],
  noExternal: [/^@droid-webscr\//],
  platform: "node",
  shims: false,
  sourcemap: true,
  splitting: false,
  target: "node24",
});
