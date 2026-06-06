import { describe, expect, it } from "vitest";
import { AdbAuthorizationState, AdbTransportKind, FakeAdbProvider } from "@droid-webscr/adb";
import { Readable } from "node:stream";
import { AdbDeviceServer, waitForDeviceServerReady } from "./start.js";
import { defaultDeviceServerArtifact } from "./artifact.js";

describe("ADB device server boundary", () => {
  it("starts and stops through the selected ADB session", async () => {
    const provider = new FakeAdbProvider([
      {
        authorizationState: AdbAuthorizationState.Authorized,
        serial: "emulator-5554",
        transportKind: AdbTransportKind.Emulator,
      },
    ]);
    const server = new AdbDeviceServer(provider);

    const session = await server.start("emulator-5554");
    const adbSession = await provider.connect("emulator-5554");

    expect(session.serial).toBe("emulator-5554");
    expect(adbSession.pushes).toEqual([
      {
        localPath: defaultDeviceServerArtifact.localPath,
        remotePath: defaultDeviceServerArtifact.remotePath,
      },
    ]);
    expect(adbSession.commands).toEqual([
      [
        "CLASSPATH=/data/local/tmp/droid-webscr-server.jar",
        "app_process",
        "/",
        "dev.droidwebscr.server.MainKt",
        "--verify-once",
        "droid-webscr",
      ],
    ]);
    await session.write(new Uint8Array([1]));
    expect(adbSession.sockets[0]?.writes).toEqual([new Uint8Array([1])]);
    await session.stop();
    expect(adbSession.sockets[0]?.closed).toBe(true);
    expect(adbSession.closed).toBe(true);
  });

  it("waits for the Android server readiness signal before opening the socket", async () => {
    await expect(
      waitForDeviceServerReady(
        Readable.from([new TextEncoder().encode("noise\ndroid-webscr:ready:droid-webscr\n")]),
        "droid-webscr",
      ),
    ).resolves.toBeUndefined();
  });

  it("fails when the Android server exits before readiness", async () => {
    await expect(waitForDeviceServerReady(Readable.from([]), "droid-webscr", 10)).rejects.toThrow(
      "Android device server exited before reporting ready.",
    );
  });
});
