import { describe, expect, it, vi } from "vitest";
import { captureCanvasPng, copyPngToClipboard } from "./capture-still.js";

describe("still capture", () => {
  it("encodes the current canvas as a PNG blob", async () => {
    const canvas = document.createElement("canvas");
    const png = new Blob(["png"], { type: "image/png" });
    canvas.toBlob = vi.fn((callback, type) => {
      expect(type).toBe("image/png");
      callback(png);
    });

    await expect(captureCanvasPng(canvas)).resolves.toBe(png);
  });

  it("rejects when the browser cannot encode the canvas", async () => {
    const canvas = document.createElement("canvas");
    canvas.toBlob = vi.fn((callback) => callback(null));

    await expect(captureCanvasPng(canvas)).rejects.toThrow("PNG capture failed");
  });

  it("copies a PNG blob to the system clipboard", async () => {
    const png = new Blob(["png"], { type: "image/png" });
    const write = vi.fn(async () => undefined);
    class ClipboardItemMock {
      public constructor(public readonly items: Record<string, Blob>) {}
    }

    await copyPngToClipboard(png, {
      ClipboardItem: ClipboardItemMock,
      write,
    });

    expect(write).toHaveBeenCalledWith([new ClipboardItemMock({ "image/png": png })]);
  });
});
