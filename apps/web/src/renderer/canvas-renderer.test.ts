import { describe, expect, it } from "vitest";
import { createCanvasRenderer, fitCanvasToViewport } from "./canvas-renderer.js";

describe("canvas renderer", () => {
  it("fits portrait and landscape video into the available viewport", () => {
    expect(fitCanvasToViewport({ height: 1280, width: 720 }, { height: 500, width: 1000 })).toEqual(
      { height: 500, left: 360, scale: 0.390625, top: 0, width: 281 },
    );
    expect(fitCanvasToViewport({ height: 720, width: 1280 }, { height: 500, width: 1000 })).toEqual(
      { height: 500, left: 56, scale: 0.6944444444444444, top: 0, width: 889 },
    );
  });

  it("resizes the backing canvas and closes rendered frames", () => {
    const canvas = document.createElement("canvas");
    const calls: unknown[] = [];
    canvas.getContext = (() =>
      ({
        clearRect: (...args: unknown[]) => calls.push(["clear", ...args]),
        drawImage: (...args: unknown[]) => calls.push(["draw", ...args]),
      }) as unknown as CanvasRenderingContext2D) as unknown as HTMLCanvasElement["getContext"];
    const renderer = createCanvasRenderer(canvas);
    const frame = { close: () => calls.push(["close"]) } as unknown as VideoFrame;

    renderer.resize({ height: 1280, width: 720 });
    renderer.clear();
    renderer.render(frame);

    expect(canvas.width).toBe(720);
    expect(canvas.height).toBe(1280);
    expect(calls[0]).toEqual(["clear", 0, 0, 720, 1280]);
    expect((calls[1] as unknown[]).slice(0, 2)).toEqual(["draw", frame]);
    expect(calls[2]).toEqual(["close"]);
  });
});
