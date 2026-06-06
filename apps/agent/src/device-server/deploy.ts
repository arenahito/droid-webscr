import { AdbDeviceSession } from "@droid-webscr/adb";
import { DeviceServerArtifact } from "./artifact.js";

export async function deployDeviceServer(
  session: AdbDeviceSession,
  artifact: DeviceServerArtifact,
): Promise<void> {
  await session.push(artifact.localPath, artifact.remotePath);
}
