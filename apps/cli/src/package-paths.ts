import { join } from "node:path";

import { deviceServerArtifactRemotePath, type DeviceServerArtifact } from "@droid-webscr/agent";

export const packagedAndroidArtifactFileName = "droid-webscr-server-android.jar";

export function resolvePackagedWebRoot(packageRoot: string): string {
  return join(packageRoot, "web");
}

export function resolvePackagedAndroidArtifact(packageRoot: string): DeviceServerArtifact {
  return {
    localPath: join(packageRoot, "android", packagedAndroidArtifactFileName),
    remotePath: deviceServerArtifactRemotePath,
  };
}
