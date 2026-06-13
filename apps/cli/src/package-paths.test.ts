import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePackagedAndroidArtifact, resolvePackagedWebRoot } from "./package-paths.js";

describe("packaged runtime paths", () => {
  it("resolves web and android artifacts from the CLI package root", () => {
    const packageRoot = "C:/repo/apps/cli";

    expect(resolvePackagedWebRoot(packageRoot)).toBe(join(packageRoot, "web"));
    expect(resolvePackagedAndroidArtifact(packageRoot)).toEqual({
      localPath: join(packageRoot, "android", "droid-webscr-server-android.jar"),
      remotePath: "/data/local/tmp/droid-webscr-server.jar",
    });
  });
});
