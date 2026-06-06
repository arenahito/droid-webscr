import { describe, expect, it } from "vitest";
import { appendLog, clearLogs, resizeLogDrawer } from "./log-drawer-state.js";

describe("log drawer state", () => {
  it("appends clears and clamps drawer height", () => {
    expect(appendLog(["a"], "b")).toEqual(["a", "b"]);
    expect(clearLogs(["a"])).toEqual([]);
    expect(resizeLogDrawer(100)).toBe(160);
    expect(resizeLogDrawer(900)).toBe(520);
    expect(resizeLogDrawer(320)).toBe(320);
  });
});
