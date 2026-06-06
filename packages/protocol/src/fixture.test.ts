import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { encodeFrame } from "./codec.js";
import { createFrameHeader } from "./frame.js";
import { MessageType } from "./messages.js";
import { StreamId } from "./streams.js";

const fixturePath = new URL("../test-fixtures/video-frame.hex", import.meta.url);

describe("cross-runtime frame fixture", () => {
  it("keeps the TypeScript encoder byte-compatible with the shared fixture", async () => {
    const expectedHex = (await readFile(fixturePath, "utf8")).trim();
    const encoded = encodeFrame({
      header: createFrameHeader({
        flags: 0x00ff,
        sequence: 9_007_199_254_740_991n,
        streamId: StreamId.Video,
        timestampUs: 1_717_171_717_171_717n,
        type: MessageType.VideoFrame,
      }),
      payload: new Uint8Array([1, 2, 3, 4]),
    });

    expect(toHex(encoded)).toBe(expectedHex);
  });
});

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
