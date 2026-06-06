import { describe, expect, it } from "vitest";
import { AdbAuthorizationState, AdbTransportKind, FakeAdbProvider } from "@droid-webscr/adb";
import { AdbDeviceServer } from "./start.js";

describe("ADB device server boundary", () => {
  it("starts and stops through the selected ADB session", async () => {
    const server = new AdbDeviceServer(
      new FakeAdbProvider([
        {
          authorizationState: AdbAuthorizationState.Authorized,
          serial: "emulator-5554",
          transportKind: AdbTransportKind.Emulator,
        },
      ]),
    );

    const session = await server.start("emulator-5554");

    expect(session.serial).toBe("emulator-5554");
    await session.write(new Uint8Array([1]));
    await session.stop();
  });
});
