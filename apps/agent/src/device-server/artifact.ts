export interface DeviceServerArtifact {
  readonly localPath: string;
  readonly remotePath: string;
}

export const defaultDeviceServerArtifact: DeviceServerArtifact = {
  localPath: "android/server/build/droid-webscr-server-android.jar",
  remotePath: "/data/local/tmp/droid-webscr-server.jar",
};
