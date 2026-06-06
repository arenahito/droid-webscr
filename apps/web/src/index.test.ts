import { describe, expect, it } from "vitest";
import { webClientLabel } from "./index.js";

describe("web app skeleton", () => {
  it("exposes the initial protocol-aware label", () => {
    expect(webClientLabel()).toBe("droid-webscr DWSC/v1");
  });
});
