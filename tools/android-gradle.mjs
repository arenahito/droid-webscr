import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const command = process.argv[2];

if (command !== "build" && command !== "check") {
  throw new Error(`Unsupported Android command: ${command ?? "<missing>"}`);
}

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
const gradleNames =
  process.platform === "win32" ? ["gradle.bat", "gradle.cmd", "gradle.exe"] : ["gradle"];

async function findGradle() {
  const paths = (process.env.PATH ?? "").split(delimiter);
  const candidates = paths.flatMap((directory) => gradleNames.map((name) => join(directory, name)));
  const checks = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      exists: await fileExists(candidate),
    })),
  );
  for (const check of checks) {
    if (check.exists) {
      return check.candidate;
    }
  }

  return undefined;
}

function runGradle(executable, gradleTask) {
  const result = spawnSync(executable, [gradleTask, "--warning-mode", "fail"], {
    cwd: new URL("../android/server/", import.meta.url),
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  process.exit(result.status ?? 1);
}

if (await fileExists(wrapperPath)) {
  const gradleTask = command === "build" ? "assemble" : "check";
  runGradle(wrapperPath, gradleTask);
}

const gradlePath = await findGradle();
if (gradlePath) {
  const gradleTask = command === "build" ? "assemble" : "check";
  runGradle(gradlePath, gradleTask);
}

throw new Error(
  "Gradle was not found. Install/use the repository-pinned Gradle tool through mise or add android/server/gradlew(.bat).",
);
