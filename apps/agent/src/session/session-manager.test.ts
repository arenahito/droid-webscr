import { describe, expect, it } from "vitest";
import { AdbAuthorizationState, AdbTransportKind, FakeAdbProvider } from "@droid-webscr/adb";
import { createSessionToken } from "../security/session-token.js";
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
    manager.delete("missing-session");
    expect(manager.verify(created.sessionId, created.token)).toBeUndefined();
  });

  it("replaces an active session when starting the same device again", async () => {
    let now = 1_000;
    const manager = new SessionManager(
      new FakeAdbProvider([
        {
          authorizationState: AdbAuthorizationState.Authorized,
          serial: "emulator-5554",
          transportKind: AdbTransportKind.Emulator,
        },
      ]),
      () => now,
      100,
    );

    const first = await manager.create("emulator-5554");
    const replacement = await manager.create("emulator-5554");

    expect(replacement.sessionId).not.toBe(first.sessionId);
    expect(manager.verify(first.sessionId, first.token)).toBeUndefined();
    expect(
      manager.verifyForDevice(replacement.sessionId, replacement.token, "emulator-5554"),
    ).toBeDefined();
    expect(manager.verifyForDevice(first.sessionId, first.token, "other-device")).toBeUndefined();
    expect(manager.cleanupExpired()).toBe(0);

    now = 1_101;
    expect(manager.cleanupExpired()).toBe(1);
    expect(manager.verify(replacement.sessionId, replacement.token)).toBeUndefined();

    const next = await manager.create("emulator-5554");
    expect(next.sessionId).not.toBe(replacement.sessionId);
  });

  it("replaces an expired duplicate session lazily when creating a new session", async () => {
    let now = 1_000;
    const manager = new SessionManager(
      new FakeAdbProvider([
        {
          authorizationState: AdbAuthorizationState.Authorized,
          serial: "emulator-5554",
          transportKind: AdbTransportKind.Emulator,
        },
      ]),
      () => now,
      100,
    );
    const expired = await manager.create("emulator-5554");

    now = 1_101;
    const fresh = await manager.create("emulator-5554");

    expect(fresh.sessionId).not.toBe(expired.sessionId);
    expect(manager.verify(expired.sessionId, expired.token)).toBeUndefined();
  });

  it("serializes concurrent duplicate session creation per device", async () => {
    let now = 2_000;
    const manager = new SessionManager(
      new FakeAdbProvider([
        {
          authorizationState: AdbAuthorizationState.Authorized,
          serial: "emulator-5554",
          transportKind: AdbTransportKind.Emulator,
        },
      ]),
      () => now,
      100,
    );

    const [first, second] = await Promise.all([
      manager.create("emulator-5554"),
      manager.create("emulator-5554"),
    ]);

    expect(second).toEqual(first);
    const active = await manager.create("emulator-5554");
    expect(active.sessionId).not.toBe(first.sessionId);
    expect(manager.verify(first.sessionId, first.token)).toBeUndefined();

    now = 2_101;
    expect(manager.cleanupExpired()).toBe(1);
    const fresh = await manager.create("emulator-5554");
    expect(fresh.sessionId).not.toBe(active.sessionId);
  });

  it("rechecks active sessions after the device list await boundary", async () => {
    let releaseDeviceList: (() => void) | undefined;
    const manager = new SessionManager(
      new (class extends FakeAdbProvider {
        public constructor() {
          super([
            {
              authorizationState: AdbAuthorizationState.Authorized,
              serial: "emulator-5554",
              transportKind: AdbTransportKind.Emulator,
            },
          ]);
        }

        public override async listDevices() {
          await new Promise<void>((resolve) => {
            releaseDeviceList = resolve;
          });
          return super.listDevices();
        }
      })(),
      () => 3_000,
      100,
    );
    const pending = manager.create("emulator-5554");
    const injected = createSessionToken("injected-session", "emulator-5554", 3_000, 100);
    (manager as unknown as { sessions: Map<string, typeof injected> }).sessions.set(
      injected.sessionId,
      injected,
    );
    (
      manager as unknown as { sessionsByDeviceSerial: Map<string, string> }
    ).sessionsByDeviceSerial.set("emulator-5554", injected.sessionId);

    releaseDeviceList?.();

    const created = await pending;
    expect(created.sessionId).not.toBe(injected.sessionId);
    expect(manager.verify(injected.sessionId, injected.token)).toBeUndefined();
  });

  it("recovers from a stale device index without blocking new session creation", async () => {
    const manager = new SessionManager(
      new FakeAdbProvider([
        {
          authorizationState: AdbAuthorizationState.Authorized,
          serial: "emulator-5554",
          transportKind: AdbTransportKind.Emulator,
        },
      ]),
      () => 3_000,
      100,
    );
    (
      manager as unknown as { sessionsByDeviceSerial: Map<string, string> }
    ).sessionsByDeviceSerial.set("emulator-5554", "missing-session");

    const created = await manager.create("emulator-5554");

    expect(created.serial).toBe("emulator-5554");
    expect(manager.verify(created.sessionId, created.token)).toBeDefined();
  });

  it("does not remove a newer device index when cleaning up or deleting stale records", () => {
    const manager = new SessionManager(new FakeAdbProvider([]), () => 5_000, 100);
    const expired = createSessionToken("expired-session", "emulator-5554", 4_000, 100);
    const active = createSessionToken("active-session", "emulator-5554", 5_000, 100);
    const internals = manager as unknown as {
      sessions: Map<string, typeof expired>;
      sessionsByDeviceSerial: Map<string, string>;
    };
    internals.sessions.set(expired.sessionId, expired);
    internals.sessions.set(active.sessionId, active);
    internals.sessionsByDeviceSerial.set("emulator-5554", active.sessionId);

    expect(manager.cleanupExpired()).toBe(1);
    expect(internals.sessionsByDeviceSerial.get("emulator-5554")).toBe(active.sessionId);

    manager.delete(expired.sessionId);
    expect(internals.sessionsByDeviceSerial.get("emulator-5554")).toBe(active.sessionId);
  });
});
