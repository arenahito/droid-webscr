import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("release-please treats all shipped sources as the droid-webscr release", async () => {
  const config = JSON.parse(await readFile("release-please-config.json", "utf8"));
  const manifest = JSON.parse(await readFile(".release-please-manifest.json", "utf8"));
  const releaseConfig = config.packages?.["."];

  assert.deepEqual(Object.keys(config.packages ?? {}), ["."]);
  assert.deepEqual(manifest, { ".": "0.3.0" });
  assert.equal(releaseConfig["package-name"], "@arenahito/droid-webscr");
  assert.equal(releaseConfig["release-type"], "simple");
  assert.equal(releaseConfig["changelog-path"], "apps/cli/CHANGELOG.md");
  assert.deepEqual(releaseConfig["extra-files"], [
    {
      jsonpath: "$.version",
      path: "apps/cli/package.json",
      type: "json",
    },
  ]);
});
