import { describe, expect, it } from "vitest";
import {
  AdbAuthorizationState,
  AdbTransportKind,
  FakeAdbProvider,
  SystemAdbProvider,
  buildLocalAbstractForward,
  isUsableDevice,
} from "./index.js";

describe("ADB provider contract", () => {
  it("lists every device kind and authorization state through one contract", async () => {
    const provider = new FakeAdbProvider([
      device("usb-1", AdbAuthorizationState.Authorized, AdbTransportKind.Usb),
      device("emulator-5554", AdbAuthorizationState.Authorized, AdbTransportKind.Emulator),
      device("192.168.0.2:5555", AdbAuthorizationState.Authorized, AdbTransportKind.Network),
      device("offline-1", AdbAuthorizationState.Offline, AdbTransportKind.Usb),
      device("unauthorized-1", AdbAuthorizationState.Unauthorized, AdbTransportKind.Usb),
    ]);

    const devices = await provider.listDevices();

    expect(devices.map((item) => item.serial)).toEqual([
      "usb-1",
      "emulator-5554",
      "192.168.0.2:5555",
      "offline-1",
      "unauthorized-1",
    ]);
    expect(devices.map(isUsableDevice)).toEqual([true, true, true, false, false]);
  });

  it("connects fake sessions and closes them deterministically", async () => {
    const provider = new FakeAdbProvider([device("emulator-5554")]);
    provider.setDeviceLogs("emulator-5554", ["line 1", "line 2", "line 3"]);

    const session = await provider.connect("emulator-5554");
    await session.push("local.jar", "/data/local/tmp/server.jar");
    const process = await session.shell(["app_process", "/", "dev.droidwebscr.server.Main"]);
    const socket = await session.openSocket("localabstract:droid-webscr");
    const logs = await provider.readDeviceLogs("emulator-5554", 2);
    await socket.write(new Uint8Array([1]));
    await socket.close();
    await session.close();

    expect(session.closed).toBe(true);
    expect(logs).toEqual(["line 2", "line 3"]);
    expect(session.pushes).toEqual([
      { localPath: "local.jar", remotePath: "/data/local/tmp/server.jar" },
    ]);
    expect(process.command).toEqual(["app_process", "/", "dev.droidwebscr.server.Main"]);
  });

  it("rejects unavailable fake device sessions", async () => {
    const provider = new FakeAdbProvider([device("offline-1", AdbAuthorizationState.Offline)]);

    await expect(provider.connect("offline-1")).rejects.toThrow("ADB device is not available");
    await expect(provider.connect("missing")).rejects.toThrow("ADB device is not available");
  });

  it("parses system adb device output behind the provider boundary", () => {
    const devices = SystemAdbProvider.parseDevices(`List of devices attached
emulator-5554 device product:sdk_gphone64 model:sdk_gphone64 transport_id:1
usb123 unauthorized usb:336592896X
192.168.1.10:5555 offline product:demo model:DemoPhone
bare123 device
`);

    expect(devices).toEqual([
      device(
        "emulator-5554",
        AdbAuthorizationState.Authorized,
        AdbTransportKind.Emulator,
        "sdk_gphone64",
      ),
      device("usb123", AdbAuthorizationState.Unauthorized, AdbTransportKind.Usb),
      device(
        "192.168.1.10:5555",
        AdbAuthorizationState.Offline,
        AdbTransportKind.Network,
        "DemoPhone",
      ),
      device("bare123", AdbAuthorizationState.Authorized, AdbTransportKind.Usb),
    ]);
  });

  it("parses empty system adb output as an empty device list", () => {
    expect(new SystemAdbProvider()).toBeInstanceOf(SystemAdbProvider);
    expect(SystemAdbProvider.parseDevices("List of devices attached\n")).toEqual([]);
  });

  it("builds adb forward arguments for Android localabstract sockets", () => {
    expect(buildLocalAbstractForward(12_345, "localabstract:droid-webscr")).toEqual({
      local: "tcp:12345",
      remote: "localabstract:droid-webscr",
    });
    expect(buildLocalAbstractForward(12_345, "droid-webscr")).toEqual({
      local: "tcp:12345",
      remote: "localabstract:droid-webscr",
    });
    expect(() => buildLocalAbstractForward(12_345, "bad socket;rm")).toThrow(
      "Invalid localabstract socket name",
    );
  });
});

function device(
  serial: string,
  authorizationState = AdbAuthorizationState.Authorized,
  transportKind = AdbTransportKind.Emulator,
  model?: string,
) {
  return {
    authorizationState,
    model,
    serial,
    transportKind,
  };
}
