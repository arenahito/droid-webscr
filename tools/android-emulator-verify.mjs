import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

async function executableExists(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function adbCandidates() {
  const names = process.platform === "win32" ? ["adb.exe", "adb.cmd", "adb.bat"] : ["adb"];
  const directories = [
    process.env.ANDROID_HOME ? join(process.env.ANDROID_HOME, "platform-tools") : undefined,
    process.env.ANDROID_SDK_ROOT ? join(process.env.ANDROID_SDK_ROOT, "platform-tools") : undefined,
    ...(process.env.PATH ?? "").split(delimiter),
  ].filter((entry) => entry && entry.length > 0);

  const candidates = [];
  for (const directory of directories) {
    for (const name of names) {
      candidates.push(join(directory, name));
    }
  }
  return candidates;
}

let adbPath;
const candidates = await adbCandidates();
const candidateChecks = await Promise.all(
  candidates.map(async (candidate) => ({
    candidate,
    exists: await executableExists(candidate),
  })),
);
for (const check of candidateChecks) {
  if (check.exists) {
    adbPath = check.candidate;
    break;
  }
}

if (!adbPath) {
  throw new Error("adb was not found. Install Android SDK platform-tools or set ANDROID_HOME.");
}

const result = spawnSync(adbPath, ["devices"], {
  encoding: "utf8",
});

if (result.status !== 0) {
  throw new Error(result.stderr.trim() || "adb devices failed.");
}

const devices = result.stdout
  .split(/\r?\n/)
  .slice(1)
  .map((line) => line.trim())
  .filter(Boolean)
  .filter((line) => /\bdevice$/.test(line));

if (devices.length === 0) {
  throw new Error("No online Android emulator/device was reported by adb devices.");
}

console.log(`android:emulator:verify found ${devices.length} online Android device(s).`);
