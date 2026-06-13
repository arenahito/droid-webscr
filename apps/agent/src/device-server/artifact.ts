import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface DeviceServerArtifact {
  readonly localPath: string;
  readonly remotePath: string;
}

export const deviceServerArtifactFileName = "droid-webscr-server-android.jar";
export const deviceServerArtifactRemotePath = "/data/local/tmp/droid-webscr-server.jar";

export const defaultDeviceServerArtifact: DeviceServerArtifact = {
  localPath: `android/server/build/${deviceServerArtifactFileName}`,
  remotePath: deviceServerArtifactRemotePath,
};

export async function resolveDeviceServerArtifact(
  moduleUrl = import.meta.url,
  startDirectory = dirname(fileURLToPath(moduleUrl)),
): Promise<DeviceServerArtifact> {
  const candidates = ancestorDirectories(startDirectory).flatMap((directory) => [
    join(directory, "android", deviceServerArtifactFileName),
    join(directory, "android", "server", "build", deviceServerArtifactFileName),
  ]);
  const checks = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      exists: await isReadableFile(candidate),
    })),
  );
  for (const check of checks) {
    if (check.exists) {
      return {
        localPath: check.candidate,
        remotePath: deviceServerArtifactRemotePath,
      };
    }
  }

  throw new Error(
    `Android server artifact was not found. Run pnpm android:build before starting droid-webscr.`,
  );
}

function ancestorDirectories(startDirectory: string): readonly string[] {
  const directories = [];
  let current = startDirectory;
  while (true) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) {
      return directories;
    }
    current = parent;
  }
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
