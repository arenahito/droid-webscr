import { describe, expect, it } from "vitest";
import { AdbAuthorizationState, AdbTransportKind, FakeAdbProvider } from "@droid-webscr/adb";
import { SessionManager } from "./session-manager.js";

describe("session manager", () => {
  it("rejects unavailable devices and expires sessions", async () => {
    let now = 100;
    const manager = new SessionManager(
      new FakeAdbProvider([
        {
          authorizationState: AdbAuthorizationState.Offline,
          serial: "offline",
          transportKind: AdbTransportKind.Usb,
        },
        {
          authorizationState: AdbAuthorizationState.Authorized,
          serial: "online",
          transportKind: AdbTransportKind.Emulator,
        },
      ]),
      () => now,
      10,
    );

    await expect(manager.create("offline")).rejects.toThrow("Device is not available");
    const created = await manager.create("online");
    expect(manager.verify(created.sessionId, created.token)?.deviceSerial).toBe("online");
    now = 111;
    expect(manager.verify(created.sessionId, created.token)).toBeUndefined();
    manager.delete(created.sessionId);
    expect(manager.verify(created.sessionId, created.token)).toBeUndefined();
  });
});
