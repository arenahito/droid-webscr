import { describe, expect, it } from "vitest";
import { packageLabel, workspaceNamespace } from "./index.js";

describe("shared workspace helpers", () => {
  it("formats package labels in the repository namespace", () => {
    expect(packageLabel("protocol")).toBe("@droid-webscr/protocol");
    expect(workspaceNamespace).toBe("@droid-webscr");
  });

  it("rejects empty package labels", () => {
    expect(() => packageLabel("")).toThrow("Package name must not be empty.");
  });
});
