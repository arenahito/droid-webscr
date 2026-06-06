import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const command = process.argv[2];

if (command !== "build" && command !== "check") {
  throw new Error(`Unsupported Android command: ${command ?? "<missing>"}`);
}

const serverDir = new URL("../android/server/", import.meta.url);
const settingsPath = new URL("settings.gradle.kts", serverDir);
const buildPath = new URL("build.gradle.kts", serverDir);

async function fileExists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

const wrapperName = process.platform === "win32" ? "gradlew.bat" : "gradlew";
const wrapperPath = join(root, "android", "server", wrapperName);

if (await fileExists(wrapperPath)) {
  const gradleTask = command === "build" ? "assemble" : "check";
  const result = spawnSync(wrapperPath, [gradleTask, "--warning-mode", "fail"], {
    cwd: new URL("../android/server/", import.meta.url),
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  process.exit(result.status ?? 1);
}

const settings = await readFile(settingsPath, "utf8");
const build = await readFile(buildPath, "utf8");

const requiredSettings = [
  "pluginManagement",
  "google()",
  "mavenCentral()",
  'rootProject.name = "droid-webscr-android-server"',
];
const requiredBuild = [
  "com.android.application",
  "org.jetbrains.kotlin.android",
  "checkAndroidServerSkeleton",
];

for (const marker of requiredSettings) {
  if (!settings.includes(marker)) {
    throw new Error(`Android settings skeleton is missing marker: ${marker}`);
  }
}

for (const marker of requiredBuild) {
  if (!build.includes(marker)) {
    throw new Error(`Android build skeleton is missing marker: ${marker}`);
  }
}

console.log(
  `android:${command} validated Android Gradle skeleton; Gradle wrapper is not present yet.`,
);
