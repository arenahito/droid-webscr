import { describe, expect, it } from "vitest";
import { createVideoDecoderBoundary } from "./video-decoder.js";

describe("video decoder boundary", () => {
  it("forwards configure decode and close to the WebCodecs decoder", () => {
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

    expect(calls).toEqual(["configure", "decode", "close"]);
  });
});
