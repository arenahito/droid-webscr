import { describe, expect, it } from "vitest";
import { createFrameHeader } from "./frame.js";
import { decodeFrame, encodeFrame } from "./codec.js";
import { MessageType } from "./messages.js";
import { StreamId } from "./streams.js";
import {
  createVideoReconfigureFrame,
  parseVideoConfigFrame,
  parseVideoFrame,
  parseVideoReconfigureFrame,
} from "./video.js";

describe("video protocol payload helpers", () => {
  it("parses AVC config metadata and codec config bytes", () => {
    const payload = new Uint8Array(19);
    const view = new DataView(payload.buffer);
    view.setUint8(0, 1);
    view.setUint8(1, 1);
    view.setUint32(4, 1080, false);
    view.setUint32(8, 2400, false);
    view.setUint32(12, 3, false);
    payload.set([1, 2, 3], 16);
    const bytes = encodeFrame({
      header: createFrameHeader({
        payloadLength: payload.byteLength,
        streamId: StreamId.Video,
        type: MessageType.VideoConfig,
      }),
      payload,
    });
    const decoded = parseDecoded(bytes);

    expect(parseVideoConfigFrame(decoded)).toEqual({
      codedHeight: 2400,
      codedWidth: 1080,
      codec: "avc1.42E01E",
      codecConfig: new Uint8Array([1, 2, 3]),
    });
  });

  it("creates and parses video reconfigure frames", () => {
    const frame = parseDecoded(
      createVideoReconfigureFrame({ bitrateMbps: 12, fps: 60, sequence: 7n }),
    );

    expect(frame.header.type).toBe(MessageType.VideoReconfigure);
    expect(frame.header.streamId).toBe(StreamId.Video);
    expect(frame.header.sequence).toBe(7n);
    expect(parseVideoReconfigureFrame(frame)).toEqual({ bitrateMbps: 12, fps: 60 });
  });

  it("parses video frame timestamp and keyframe flag", () => {
    const bytes = encodeFrame({
      header: createFrameHeader({
        flags: 1,
        payloadLength: 3,
        streamId: StreamId.Video,
        timestampUs: 42n,
        type: MessageType.VideoFrame,
      }),
      payload: new Uint8Array([0, 0, 1]),
    });

    expect(parseVideoFrame(parseDecoded(bytes))).toEqual({
      data: new Uint8Array([0, 0, 1]),
      keyFrame: true,
      timestampUs: 42n,
    });
  });

  it("rejects malformed video config frames", () => {
    expect(() =>
      parseVideoConfigFrame({
        header: createFrameHeader({
          payloadLength: 0,
          streamId: StreamId.Video,
          type: MessageType.VideoConfig,
        }),
        payload: new Uint8Array(),
      }),
    ).toThrow("shorter than 16 bytes");
    expect(() =>
      parseVideoConfigFrame(
        parseDecoded(
          encodeFrame({
            header: createFrameHeader({
              payloadLength: 16,
              streamId: StreamId.Video,
              type: MessageType.VideoConfig,
            }),
            payload: new Uint8Array(16),
          }),
        ),
      ),
    ).toThrow("Unsupported video codec id");
    expect(() =>
      parseVideoConfigFrame({
        header: createFrameHeader({
          payloadLength: 16,
          streamId: StreamId.Video,
          type: MessageType.VideoConfig,
        }),
        payload: (() => {
          const payload = new Uint8Array(16);
          new DataView(payload.buffer).setUint8(0, 1);
          new DataView(payload.buffer).setUint32(12, 1, false);
          return payload;
        })(),
      }),
    ).toThrow("does not match declared codec config length");
  });

  it("rejects frames from the wrong type or stream", () => {
    expect(() =>
      parseVideoFrame({
        header: createFrameHeader({
          streamId: StreamId.Session,
          type: MessageType.VideoFrame,
        }),
        payload: new Uint8Array(),
      }),
    ).toThrow("Expected video stream");
    expect(() =>
      parseVideoFrame({
        header: createFrameHeader({
          streamId: StreamId.Video,
          type: MessageType.VideoConfig,
        }),
        payload: new Uint8Array(),
      }),
    ).toThrow("Expected message type");
    expect(() =>
      parseVideoConfigFrame({
        header: createFrameHeader({
          streamId: StreamId.Video,
          type: MessageType.VideoFrame,
        }),
        payload: new Uint8Array(16),
      }),
    ).toThrow("Expected message type");
    expect(() =>
      parseVideoConfigFrame({
        header: createFrameHeader({
          streamId: StreamId.Session,
          type: MessageType.VideoConfig,
        }),
        payload: new Uint8Array(16),
      }),
    ).toThrow("Expected video stream");
  });
});

function parseDecoded(bytes: Uint8Array) {
  const decoded = decodeFrame(bytes);
  if (!decoded.ok) {
    throw decoded.error;
  }
  return decoded.value;
}
