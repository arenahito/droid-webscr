import { describe, expect, it } from "vitest";
import { cleanupAll } from "./index.js";

describe("async cleanup utilities", () => {
  it("runs cleanup callbacks in reverse registration order", async () => {
    const calls: string[] = [];

    await cleanupAll([
      () => {
        calls.push("first");
      },
      async () => {
        calls.push("second");
      },
    ]);

    expect(calls).toEqual(["second", "first"]);
  });

  it("rethrows the first cleanup failure after running every callback", async () => {
    const calls: string[] = [];

    await expect(
      cleanupAll([
        () => {
          calls.push("first");
          throw new Error("first failed");
        },
        () => {
          calls.push("second");
          throw new Error("second failed");
        },
      ]),
    ).rejects.toThrow("second failed");

    expect(calls).toEqual(["second", "first"]);
  });
});
