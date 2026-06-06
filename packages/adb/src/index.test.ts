import { describe, expect, it } from "vitest";
import { isUsableDevice } from "./index.js";

describe("ADB package skeleton", () => {
  it("accepts only connected devices with serials", () => {
    expect(isUsableDevice({ serial: "emulator-5554", state: "device" })).toBe(true);
    expect(isUsableDevice({ serial: "", state: "device" })).toBe(false);
    expect(isUsableDevice({ serial: "emulator-5554", state: "offline" })).toBe(false);
  });
});
