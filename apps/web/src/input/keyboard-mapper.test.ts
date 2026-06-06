import { decodeFrame, MessageType, StreamId } from "@droid-webscr/protocol";
import { describe, expect, it } from "vitest";
import { mapKeyboardToControlFrame } from "./keyboard-mapper.js";

describe("keyboard mapper", () => {
  it("maps browser keys to Android keycode binary frames", () => {
    const frame = mapKeyboardToControlFrame({
      action: "down",
      code: "Backspace",
      metaState: 1,
      repeat: 2,
      sequence: 3n,
    });
    expect(frame).toBeDefined();
    if (!frame) {
      return;
    }
    const decoded = decodeFrame(frame);

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.value.header.type).toBe(MessageType.ControlKey);
    expect(decoded.value.header.streamId).toBe(StreamId.Control);
    expect([...decoded.value.payload]).toEqual([1, 0, 0, 67, 0, 0, 0, 1, 0, 0, 0, 2]);
  });

  it("returns undefined for unmapped browser keys", () => {
    expect(
      mapKeyboardToControlFrame({ action: "up", code: "F24", metaState: 0, repeat: 0 }),
    ).toBeUndefined();
  });

  it("encodes mapped key releases", () => {
    const frame = mapKeyboardToControlFrame({
      action: "up",
      code: "Enter",
      metaState: 0,
      repeat: 0,
    });
    expect(frame).toBeDefined();
    if (!frame) {
      return;
    }
    const decoded = decodeFrame(frame);

    expect(decoded.ok && decoded.value.payload[0]).toBe(2);
  });
});
