import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildAndroidServerArtifact, createProcessRunner } from "./android-emulator-verify-lib.mjs";

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
  const gradleInvocation =
    process.platform === "win32" && /\.(bat|cmd)$/i.test(executable)
      ? {
          args: ["/d", "/c", executable, gradleTask, "--warning-mode", "fail"],
          executable: "cmd.exe",
        }
      : { args: [gradleTask, "--warning-mode", "fail"], executable };
  const result = spawnSync(gradleInvocation.executable, gradleInvocation.args, {
    cwd: new URL("../android/server/", import.meta.url),
    stdio: "inherit",
  });
  const status = result.status ?? 1;
  if (status !== 0) {
    process.exit(status);
  }
}

async function buildDeployArtifact() {
  await buildAndroidServerArtifact({
    artifactPath: "android/server/build/droid-webscr-server-android.jar",
    runner: createProcessRunner(),
  });
}

async function runAndroidCommand(executable) {
  const gradleTask = command === "build" ? "assemble" : "check";
  runGradle(executable, gradleTask);
  if (command === "build") {
    await buildDeployArtifact();
  }
  process.exit(0);
}

if (await fileExists(wrapperPath)) {
  await runAndroidCommand(wrapperPath);
}

const gradlePath = await findGradle();
if (gradlePath) {
  await runAndroidCommand(gradlePath);
}

throw new Error(
  "Gradle was not found. Install/use the repository-pinned Gradle tool through mise or add android/server/gradlew(.bat).",
);
