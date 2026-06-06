export interface DeviceServerArtifact {
  readonly localPath: string;
  readonly remotePath: string;
}

export const defaultDeviceServerArtifact: DeviceServerArtifact = {
  localPath: "android/server/build/install/server/server.jar",
  remotePath: "/data/local/tmp/droid-webscr-server.jar",
};
