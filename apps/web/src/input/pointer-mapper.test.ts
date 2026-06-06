import { decodeFrame, MessageType, StreamId } from "@droid-webscr/protocol";
import { describe, expect, it } from "vitest";
import { fitViewport, mapPointerToControlFrame } from "./pointer-mapper.js";

describe("pointer mapper", () => {
  it("fits portrait and landscape displays without overflowing the container", () => {
    expect(
      fitViewport({ height: 1200, rotation: 0, width: 600 }, { height: 640, width: 900 }),
    ).toEqual({ height: 640, width: 320 });
    expect(
      fitViewport({ height: 600, rotation: 90, width: 1200 }, { height: 640, width: 900 }),
    ).toEqual({ height: 450, width: 900 });
  });

  it("normalizes browser pointer coordinates into binary control frames", () => {
    const frame = mapPointerToControlFrame({
      action: "down",
      buttons: 1,
      display: { height: 1920, rotation: 0, width: 1080 },
      pointerId: 7,
      pressure: 0.5,
      sequence: 9n,
      viewport: { height: 640, left: 100, top: 40, width: 360 },
      x: 280,
      y: 360,
    });
    const decoded = decodeFrame(frame);

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.value.header.type).toBe(MessageType.ControlPointer);
    expect(decoded.value.header.streamId).toBe(StreamId.Control);
    expect([...decoded.value.payload]).toEqual([
      0, 0, 0, 7, 0, 0, 2, 28, 0, 0, 3, 192, 128, 0, 0, 1, 0, 0, 0, 0,
    ]);
  });

  it("encodes move and up actions while clamping pointer bounds", () => {
    const move = decodeFrame(
      mapPointerToControlFrame({
        action: "move",
        buttons: 1,
        display: { height: 100, rotation: 0, width: 100 },
        pointerId: 1,
        pressure: 2,
        viewport: { height: 100, left: 0, top: 0, width: 100 },
        x: 150,
        y: -10,
      }),
    );
    const up = decodeFrame(
      mapPointerToControlFrame({
        action: "up",
        buttons: 0,
        display: { height: 100, rotation: 180, width: 100 },
        pointerId: 1,
        pressure: -1,
        viewport: { height: 100, left: 0, top: 0, width: 100 },
        x: 0,
        y: 0,
      }),
    );

    expect(move.ok && [...move.value.payload].slice(0, 13)).toEqual([
      1, 0, 0, 1, 0, 0, 0, 99, 0, 0, 0, 0, 255,
    ]);
    expect(up.ok && up.value.payload[0]).toBe(2);
  });

  it("never emits coordinates outside Android exclusive display bounds", () => {
    const frame = decodeFrame(
      mapPointerToControlFrame({
        action: "down",
        buttons: 1,
        display: { height: 200, rotation: 0, width: 100 },
        pointerId: 0,
        pressure: 1,
        viewport: { height: 10, left: 0, top: 0, width: 10 },
        x: 10,
        y: 10,
      }),
    );

    expect(frame.ok && [...frame.value.payload].slice(4, 12)).toEqual([0, 0, 0, 99, 0, 0, 0, 199]);
    expect(() =>
      mapPointerToControlFrame({
        action: "down",
        buttons: 1,
        display: { height: 200, rotation: 0, width: 100 },
        pointerId: 0,
        pressure: 1,
        viewport: { height: 0, left: 0, top: 0, width: 10 },
        x: 0,
        y: 0,
      }),
    ).toThrow("Viewport dimensions must be positive.");
  });
});
