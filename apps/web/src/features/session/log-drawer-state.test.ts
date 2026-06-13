import { describe, expect, it } from "vitest";
import { appendLog, appendLogs, clearLogs, resizeLogDrawer } from "./log-drawer-state.js";

describe("log drawer state", () => {
  it("appends clears and clamps drawer height", () => {
    expect(appendLog(["a"], "b")).toEqual(["a", "b"]);
    expect(clearLogs(["a"])).toEqual([]);
    expect(resizeLogDrawer(100)).toBe(160);
    expect(resizeLogDrawer(900)).toBe(520);
    expect(resizeLogDrawer(320)).toBe(320);
  });

  it("keeps only the latest 5000 log lines", () => {
    const existingLogs = Array.from({ length: 5000 }, (_, index) => `line ${index}`);

    const nextLogs = appendLog(existingLogs, "line 5000");

    expect(nextLogs).toHaveLength(5000);
    expect(nextLogs[0]).toBe("line 1");
    expect(nextLogs.at(-1)).toBe("line 5000");
  });

  it("batches log append trimming in one pass", () => {
    const existingLogs = Array.from({ length: 4998 }, (_, index) => `line ${index}`);

    const nextLogs = appendLogs(existingLogs, ["line 4998", "line 4999", "line 5000"]);

    expect(nextLogs).toHaveLength(5000);
    expect(nextLogs[0]).toBe("line 1");
    expect(nextLogs.at(-1)).toBe("line 5000");
  });
});
