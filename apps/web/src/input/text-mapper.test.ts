import { decodeFrame, MessageType, StreamId } from "@droid-webscr/protocol";
import { describe, expect, it } from "vitest";
import { mapTextToControlFrame } from "./text-mapper.js";

describe("text mapper", () => {
  it("encodes UTF-8 text control frames", () => {
    const frame = mapTextToControlFrame({ sequence: 5n, text: "Hi" });
    const decoded = decodeFrame(frame);

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.value.header.type).toBe(MessageType.ControlText);
    expect(decoded.value.header.streamId).toBe(StreamId.Control);
    expect(decoded.value.header.sequence).toBe(5n);
    expect(new TextDecoder().decode(decoded.value.payload)).toBe("Hi");
  });
});
