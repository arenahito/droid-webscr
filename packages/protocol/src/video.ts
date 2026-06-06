import { ProtocolFrame } from "./codec.js";
import { MessageType } from "./messages.js";
import { StreamId } from "./streams.js";

export const VIDEO_FRAME_FLAG_KEY_FRAME = 1;

export interface VideoConfigPayload {
  readonly codec: "avc1.42E01E";
  readonly codecConfig: Uint8Array;
  readonly codedHeight: number;
  readonly codedWidth: number;
}

export interface VideoFramePayload {
  readonly data: Uint8Array;
  readonly keyFrame: boolean;
  readonly timestampUs: bigint;
}

export function parseVideoConfigFrame(frame: ProtocolFrame): VideoConfigPayload {
  requireFrame(frame, MessageType.VideoConfig);
  if (frame.payload.byteLength < 16) {
    throw new Error("VIDEO_CONFIG payload is shorter than 16 bytes.");
  }
  const view = new DataView(
    frame.payload.buffer,
    frame.payload.byteOffset,
    frame.payload.byteLength,
  );
  const codec = view.getUint8(0);
  if (codec !== 1) {
    throw new Error(`Unsupported video codec id: ${codec}.`);
  }
  const codedWidth = view.getUint32(4, false);
  const codedHeight = view.getUint32(8, false);
  const codecConfigLength = view.getUint32(12, false);
  const expectedLength = 16 + codecConfigLength;
  if (frame.payload.byteLength !== expectedLength) {
    throw new Error(
      `VIDEO_CONFIG payload length ${frame.payload.byteLength} does not match declared codec config length ${codecConfigLength}.`,
    );
  }
  return {
    codedHeight,
    codedWidth,
    codec: "avc1.42E01E",
    codecConfig: frame.payload.slice(16),
  };
}

export function parseVideoFrame(frame: ProtocolFrame): VideoFramePayload {
  requireFrame(frame, MessageType.VideoFrame);
  return {
    data: frame.payload,
    keyFrame: (frame.header.flags & VIDEO_FRAME_FLAG_KEY_FRAME) !== 0,
    timestampUs: frame.header.timestampUs,
  };
}

function requireFrame(frame: ProtocolFrame, type: MessageType): void {
  if (frame.header.type !== type) {
    throw new Error(`Expected message type ${type}, received ${frame.header.type}.`);
  }
  if (frame.header.streamId !== StreamId.Video) {
    throw new Error(`Expected video stream, received stream ${frame.header.streamId}.`);
  }
}
