import { describe, expect, it } from "vitest";
import { createBaselineH264Config, createWebCodecsH264Config } from "./h264-config.js";

describe("H264 WebCodecs config boundary", () => {
  it("keeps the baseline config helper for static fallback UI state", () => {
    expect(createBaselineH264Config(720, 1280)).toEqual({
      codec: "avc1.42E01E",
      codedHeight: 1280,
      codedWidth: 720,
    });
  });

  it("omits description for Annex B codec config and derives the avc codec string from SPS", () => {
    const config = createWebCodecsH264Config({
      codecConfig: new Uint8Array([
        0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1e, 0xaa, 0xbb, 0, 0, 0, 1, 0x68, 0xcc, 0xdd,
      ]),
      height: 1280,
      width: 720,
    });

    expect(config).toEqual({
      codec: "avc1.42E01E",
      codedHeight: 1280,
      codedWidth: 720,
    });
  });

  it("passes AVCDecoderConfigurationRecord bytes through as description", () => {
    const avcc = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28]);

    const config = createWebCodecsH264Config({
      codecConfig: avcc,
      height: 1920,
      width: 1080,
    });

    expect(config.codec).toBe("avc1.640028");
    expect(config.description).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(config.description as ArrayBuffer))).toEqual([...avcc]);
  });

  it("rejects codec config bytes that do not expose SPS metadata", () => {
    expect(() =>
      createWebCodecsH264Config({
        codecConfig: new Uint8Array([0, 0, 1, 0x68, 1, 2, 3]),
        height: 1280,
        width: 720,
      }),
    ).toThrow("H.264 codec configuration does not contain SPS metadata.");
  });
});
