import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveDeviceServerArtifact } from "./artifact.js";

describe("device server artifact resolution", () => {
  it("prefers the packaged Android artifact next to the built CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "droid-webscr-package-"));
    const packageDir = join(root, "apps", "agent");
    const distDir = join(packageDir, "dist");
    const artifactPath = join(packageDir, "android", "droid-webscr-server-android.jar");
    await mkdir(distDir, { recursive: true });
    await mkdir(join(packageDir, "android"), { recursive: true });
    await writeFile(artifactPath, "jar");

    await expect(resolveDeviceServerArtifact(import.meta.url, distDir)).resolves.toEqual({
      localPath: artifactPath,
      remotePath: "/data/local/tmp/droid-webscr-server.jar",
    });
  });

  it("falls back to the repository Android build artifact during development", async () => {
    const root = await mkdtemp(join(tmpdir(), "droid-webscr-repo-"));
    const packageDir = join(root, "apps", "agent");
    const distDir = join(packageDir, "dist");
    const artifactPath = join(
      root,
      "android",
      "server",
      "build",
      "droid-webscr-server-android.jar",
    );
    await mkdir(distDir, { recursive: true });
    await mkdir(join(root, "android", "server", "build"), { recursive: true });
    await writeFile(artifactPath, "jar");

    await expect(resolveDeviceServerArtifact(import.meta.url, distDir)).resolves.toEqual({
      localPath: artifactPath,
      remotePath: "/data/local/tmp/droid-webscr-server.jar",
    });
  });

  it("fails clearly when neither packaged nor repository artifact exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "droid-webscr-missing-"));
    const distDir = join(root, "apps", "agent", "dist");
    await mkdir(distDir, { recursive: true });

    await expect(resolveDeviceServerArtifact(import.meta.url, distDir)).rejects.toThrow(
      "Android server artifact was not found.",
    );
  });
});
