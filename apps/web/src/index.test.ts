import { describe, expect, it } from "vitest";
import { webClientLabel } from "./index.js";

describe("web package entry", () => {
  it("exposes the shared protocol label", () => {
    expect(webClientLabel()).toBe("droid-webscr DWSC/v1");
  });
});
