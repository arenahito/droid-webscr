import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { isDirectRun } from "./main.js";

describe("isDirectRun", () => {
  it("accepts the current module URL when Node runs the compiled entrypoint", () => {
    const entrypoint = "C:/repo/apps/agent/dist/main.js";
    expect(isDirectRun(pathToFileURL(entrypoint).href, ["/node", entrypoint])).toBe(true);
  });

  it("rejects imports from other entrypoints", () => {
    expect(
      isDirectRun("file:///repo/apps/agent/dist/main.js", ["/node", "/repo/tools/dev.js"]),
    ).toBe(false);
  });
});
