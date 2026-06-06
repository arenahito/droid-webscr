import { describe, expect, it } from "vitest";
import { decodeFrame } from "./codec.js";
import {
  createKeyControlFrame,
  createPointerControlFrame,
  createSystemControlFrame,
  createTextControlFrame,
} from "./control.js";
import { MessageType } from "./messages.js";
import { StreamId } from "./streams.js";

describe("control protocol payload helpers", () => {
  it("encodes pointer payloads with Android parity wire values", () => {
    const decoded = decodeFrame(
      createPointerControlFrame({
        action: "down",
        buttons: 1,
        displayId: 2,
        pointerId: 7,
        pressure: 0.5,
        sequence: 9n,
        x: 540,
        y: 960,
      }),
    );

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.value.header.type).toBe(MessageType.ControlPointer);
    expect(decoded.value.header.streamId).toBe(StreamId.Control);
    expect(decoded.value.header.sequence).toBe(9n);
    expect([...decoded.value.payload]).toEqual([
      0, 0, 0, 7, 0, 0, 2, 28, 0, 0, 3, 192, 128, 0, 0, 1, 0, 0, 0, 2,
    ]);
  });

  it("encodes key text and system control frames", () => {
    const key = decodeFrame(
      createKeyControlFrame({
        action: "up",
        keyCode: 66,
        metaState: 1,
        repeat: 2,
      }),
    );
    const text = decodeFrame(createTextControlFrame({ text: "Hi" }));
    const system = decodeFrame(createSystemControlFrame("home"));

    expect(key.ok && key.value.header.type).toBe(MessageType.ControlKey);
    expect(key.ok && [...key.value.payload]).toEqual([1, 0, 0, 66, 0, 0, 0, 1, 0, 0, 0, 2]);
    expect(text.ok && text.value.header.type).toBe(MessageType.ControlText);
    expect(text.ok && new TextDecoder().decode(text.value.payload)).toBe("Hi");
    expect(system.ok && system.value.header.type).toBe(MessageType.ControlSystem);
    expect(system.ok && [...system.value.payload]).toEqual([1]);
  });

  it("encodes cancel and back variants with timestamp metadata", () => {
    const pointer = decodeFrame(
      createPointerControlFrame({
        action: "cancel",
        buttons: 0,
        pointerId: 1,
        pressure: 2,
        timestampUs: 8n,
        x: 0,
        y: 0,
      }),
    );
    const system = decodeFrame(createSystemControlFrame("back", { timestampUs: 9n }));

    expect(pointer.ok && pointer.value.header.timestampUs).toBe(8n);
    expect(pointer.ok && pointer.value.payload[0]).toBe(3);
    expect(system.ok && system.value.header.timestampUs).toBe(9n);
    expect(system.ok && system.value.payload[0]).toBe(0);
  });
});
