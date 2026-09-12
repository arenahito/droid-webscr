import { describe, expect, it, vi } from "vitest";
import { createVideoDecoderBoundary } from "./video-decoder.js";

describe("video decoder boundary", () => {
  it("forwards operations and closes the WebCodecs decoder once", () => {
    const calls: string[] = [];
    const decoder = {
      close: () => calls.push("close"),
      configure: () => calls.push("configure"),
      decode: () => calls.push("decode"),
    } as unknown as VideoDecoder;
    const boundary = createVideoDecoderBoundary(decoder);

    boundary.configure({ codec: "avc1.42E01E" });
    boundary.decode({} as EncodedVideoChunk);
    boundary.close();
    boundary.close();

    expect(calls).toEqual(["configure", "decode", "close"]);
  });

  it("does not close an already-closed WebCodecs decoder", () => {
    const close = vi.fn(() => {
      throw new Error("VideoDecoder is already closed");
    });
    const decoder = {
      close,
      configure: vi.fn(),
      decode: vi.fn(),
      state: "closed",
    } as unknown as VideoDecoder;
    const boundary = createVideoDecoderBoundary(decoder);

    expect(() => boundary.close()).not.toThrow();
    expect(close).not.toHaveBeenCalled();
  });
});
