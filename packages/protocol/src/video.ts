import { ProtocolFrame } from "./codec.js";
import { createFrameHeader } from "./frame.js";
import { encodeFrame } from "./codec.js";
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

export interface VideoReconfigureInput {
  readonly bitrateMbps: number;
  readonly fps: number;
  readonly sequence?: bigint | undefined;
}

export interface VideoReconfigurePayload {
  readonly bitrateMbps: number;
  readonly fps: number;
}

export function createVideoReconfigureFrame(input: VideoReconfigureInput): Uint8Array {
  const payload = new Uint8Array(8);
  const view = new DataView(payload.buffer);
  view.setUint32(0, input.bitrateMbps, false);
  view.setUint32(4, input.fps, false);
  return encodeFrame({
    header: createFrameHeader({
      payloadLength: payload.byteLength,
      streamId: StreamId.Video,
      type: MessageType.VideoReconfigure,
      ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
    }),
    payload,
  });
}

export function parseVideoReconfigureFrame(frame: ProtocolFrame): VideoReconfigurePayload {
  requireFrame(frame, MessageType.VideoReconfigure);
  if (frame.payload.byteLength !== 8) {
    throw new Error("VIDEO_RECONFIGURE payload must be 8 bytes.");
  }
  const view = new DataView(
    frame.payload.buffer,
    frame.payload.byteOffset,
    frame.payload.byteLength,
  );
  return {
    bitrateMbps: view.getUint32(0, false),
    fps: view.getUint32(4, false),
  };
}

export function parseVideoConfigFrame(frame: ProtocolFrame): VideoConfigPayload {
  requireVideoConfigFrame(frame);
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

function requireVideoConfigFrame(frame: ProtocolFrame): void {
  if (
    frame.header.type !== MessageType.VideoConfig &&
    frame.header.type !== MessageType.VideoReconfigure
  ) {
    throw new Error(
      `Expected message type ${MessageType.VideoConfig}, received ${frame.header.type}.`,
    );
  }
  if (frame.header.streamId !== StreamId.Video) {
    throw new Error(`Expected video stream, received stream ${frame.header.streamId}.`);
  }
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
