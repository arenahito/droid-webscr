import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

const text = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const json = async (path) => JSON.parse(await text(path));

test("root package exposes the required quality gate contract", async () => {
  const pkg = await json("package.json");
  const requiredScripts = [
    "dev",
    "build",
    "check",
    "lint",
    "lint-fix",
    "format",
    "format:check",
    "type-check",
    "typecheck",
    "test",
    "test:coverage",
    "android:build",
    "android:check",
    "android:emulator:verify",
  ];

  assert.match(pkg.packageManager, /^pnpm@11\./);
  assert.equal(pkg.private, true);
  for (const script of requiredScripts) {
    assert.equal(typeof pkg.scripts?.[script], "string", `missing script: ${script}`);
  }
});

test("workspace boundaries match the planned long-lived package layout", async () => {
  const workspace = await text("pnpm-workspace.yaml");
  for (const entry of ["apps/*", "packages/*"]) {
    assert.match(workspace, new RegExp(`- "${entry.replace("*", "\\*")}"`));
  }
  assert.doesNotMatch(workspace, /android\/server/);

  const packagePaths = [
    "apps/agent/package.json",
    "apps/web/package.json",
    "packages/protocol/package.json",
    "packages/adb/package.json",
    "packages/transport/package.json",
    "packages/config/package.json",
    "packages/shared/package.json",
  ];

  const packageJsons = await Promise.all(packagePaths.map((path) => json(path)));
  for (const pkg of packageJsons) {
    assert.match(pkg.name, /^@droid-webscr\//);
  }
});

test("workspace library packages expose build artifacts at runtime while keeping source types", async () => {
  const packagePaths = [
    "packages/protocol/package.json",
    "packages/adb/package.json",
    "packages/transport/package.json",
    "packages/config/package.json",
    "packages/shared/package.json",
  ];

  const packageJsons = await Promise.all(packagePaths.map((path) => json(path)));
  for (const pkg of packageJsons) {
    assert.deepEqual(pkg.exports, {
      ".": {
        types: "./src/index.ts",
        default: "./dist/index.js",
      },
    });
  }
});

test("strict TypeScript options are enabled at the base config", async () => {
  const config = await json("tsconfig.base.json");
  assert.equal(config.compilerOptions.strict, true);
  assert.equal(config.compilerOptions.noUncheckedIndexedAccess, true);
  assert.equal(config.compilerOptions.exactOptionalPropertyTypes, true);
  assert.equal(config.compilerOptions.useUnknownInCatchVariables, true);
});

test("web dev server keeps the agent CORS development origin stable", async () => {
  const config = await text("apps/web/vite.config.ts");
  assert.match(config, /strictPort:\s*true/);
});
