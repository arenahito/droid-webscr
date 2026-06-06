import { describe, expect, it } from "vitest";
import { canSend } from "./index.js";

describe("transport package skeleton", () => {
  it("permits sends only while open", () => {
    expect(canSend("open")).toBe(true);
    expect(canSend("idle")).toBe(false);
    expect(canSend("connecting")).toBe(false);
    expect(canSend("closed")).toBe(false);
  });
});
