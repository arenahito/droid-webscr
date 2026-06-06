import { describe, expect, it } from "vitest";
import { createFrameHeader, MessageType, StreamId } from "@droid-webscr/protocol";
import { applyBackpressure, VIDEO_KEYFRAME_FLAG } from "./backpressure.js";

describe("video backpressure policy", () => {
  it("drops oldest non-keyframes before keyframes when capacity is exceeded", () => {
    const frames = [frame(1n, 0), frame(2n, VIDEO_KEYFRAME_FLAG), frame(3n, 0), frame(4n, 0)];

    const result = applyBackpressure(frames, { maxQueuedFrames: 2 });

    expect(result.kept.map((item) => item.header.sequence)).toEqual([2n, 4n]);
    expect(result.dropped.map((item) => item.header.sequence)).toEqual([1n, 3n]);
  });

  it("keeps the newest frames if every queued frame is a keyframe", () => {
    const frames = [frame(1n, VIDEO_KEYFRAME_FLAG), frame(2n, VIDEO_KEYFRAME_FLAG)];

    const result = applyBackpressure(frames, { maxQueuedFrames: 1 });

    expect(result.kept.map((item) => item.header.sequence)).toEqual([2n]);
    expect(result.dropped.map((item) => item.header.sequence)).toEqual([1n]);
  });

  it("rejects invalid queue capacity", () => {
    expect(() => applyBackpressure([], { maxQueuedFrames: -1 })).toThrow(
      "maxQueuedFrames must be non-negative",
    );
  });
});

function frame(sequence: bigint, flags: number) {
  return {
    header: createFrameHeader({
      flags,
      sequence,
      streamId: StreamId.Video,
      type: MessageType.VideoFrame,
    }),
    payload: new Uint8Array(),
  };
}
