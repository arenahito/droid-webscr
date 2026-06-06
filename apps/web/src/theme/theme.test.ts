import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../lib/memory-storage.js";
import { applyTheme, persistTheme, readTheme } from "./theme.js";

describe("theme preference", () => {
  it("defaults to dark and persists light theme", () => {
    const storage = createMemoryStorage();
    const element = document.createElement("div");

    expect(readTheme(storage)).toBe("dark");
    persistTheme(storage, "light");
    applyTheme(readTheme(storage), element);

    expect(storage.getItem("droid-webscr.theme")).toBe("light");
    expect(element.dataset.theme).toBe("light");
    storage.removeItem("droid-webscr.theme");
    expect(readTheme(storage)).toBe("dark");
  });
});
