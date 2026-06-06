import { describe, expect, it } from "vitest";
import { describeProtocol, protocolMagic, protocolVersion } from "./index.js";

describe("protocol package skeleton", () => {
  it("exposes the binary protocol identity", () => {
    expect(protocolMagic).toBe("DWSC");
    expect(protocolVersion).toBe(1);
    expect(describeProtocol()).toBe("DWSC/v1");
  });
});
