import { describe, expect, it } from "vitest";
import { FRAME_HEADER_LENGTH, FRAME_MAGIC, WIRE_VERSION, createFrameHeader } from "./frame.js";
import { ProtocolErrorCode, decodeFrame, encodeFrame, isProtocolError } from "./codec.js";
import { MessageType, classifyMessageType, isControlMessage, isVideoMessage } from "./messages.js";
import { StreamId, classifyStream } from "./streams.js";

const payload = new Uint8Array([1, 2, 3, 4]);

describe("binary frame codec", () => {
  it("round-trips every frame field exactly with a big-endian 40-byte header", () => {
    const header = createFrameHeader({
      flags: 0x00ff,
      sequence: 9_007_199_254_740_991n,
      streamId: StreamId.Video,
      timestampUs: 1_717_171_717_171_717n,
      type: MessageType.VideoFrame,
    });

    const encoded = encodeFrame({ header, payload });
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);

    expect(encoded.byteLength).toBe(FRAME_HEADER_LENGTH + payload.byteLength);
    expect(view.getUint32(0, false)).toBe(FRAME_MAGIC);
    expect(view.getUint16(4, false)).toBe(WIRE_VERSION);
    expect(view.getUint16(6, false)).toBe(FRAME_HEADER_LENGTH);
    expect(view.getUint16(8, false)).toBe(MessageType.VideoFrame);
    expect(view.getUint16(10, false)).toBe(0x00ff);
    expect(view.getUint32(12, false)).toBe(StreamId.Video);
    expect(view.getUint32(16, false)).toBe(payload.byteLength);
    expect(view.getBigUint64(20, false)).toBe(1_717_171_717_171_717n);
    expect(view.getBigUint64(28, false)).toBe(9_007_199_254_740_991n);
    expect(view.getUint32(36, false)).toBe(0);

    const decoded = decodeFrame(encoded);

    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.header).toEqual({
        flags: 0x00ff,
        headerLength: FRAME_HEADER_LENGTH,
        magic: FRAME_MAGIC,
        payloadLength: payload.byteLength,
        reserved: 0,
        sequence: 9_007_199_254_740_991n,
        streamId: StreamId.Video,
        timestampUs: 1_717_171_717_171_717n,
        type: MessageType.VideoFrame,
        version: WIRE_VERSION,
      });
      expect([...decoded.value.payload]).toEqual([...payload]);
    }
  });

  it("returns typed errors for invalid magic", () => {
    const encoded = encodeFrame({
      header: createFrameHeader({ type: MessageType.SessionHello }),
      payload: new Uint8Array(),
    });
    encoded[3] = 0;

    const decoded = decodeFrame(encoded);

    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(isProtocolError(decoded.error)).toBe(true);
      expect(decoded.error.code).toBe(ProtocolErrorCode.InvalidMagic);
    }
  });

  it("returns typed errors for frames shorter than the header", () => {
    const decoded = decodeFrame(new Uint8Array(FRAME_HEADER_LENGTH - 1));

    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error.code).toBe(ProtocolErrorCode.FrameTooShort);
    }
  });

  it("returns typed errors for unsupported wire version", () => {
    const encoded = encodeFrame({
      header: createFrameHeader({ type: MessageType.SessionHello }),
      payload: new Uint8Array(),
    });
    new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).setUint16(4, 99, false);

    const decoded = decodeFrame(encoded);

    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error.code).toBe(ProtocolErrorCode.UnsupportedVersion);
    }
  });

  it("returns typed errors for unsupported header length", () => {
    const encoded = encodeFrame({
      header: createFrameHeader({ type: MessageType.SessionHello }),
      payload: new Uint8Array(),
    });
    new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).setUint16(6, 32, false);

    const decoded = decodeFrame(encoded);

    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error.code).toBe(ProtocolErrorCode.UnsupportedHeaderLength);
    }
  });

  it("checks payload length before slicing", () => {
    const encoded = encodeFrame({
      header: createFrameHeader({ type: MessageType.VideoConfig }),
      payload,
    });
    new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).setUint32(16, 99, false);

    const decoded = decodeFrame(encoded);

    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error.code).toBe(ProtocolErrorCode.PayloadLengthMismatch);
    }
  });

  it("honors configurable maximum payload length", () => {
    const allowed = decodeFrame(
      encodeFrame({
        header: createFrameHeader({ type: MessageType.VideoFrame }),
        payload,
      }),
      { maxPayloadLength: payload.byteLength },
    );
    const rejected = decodeFrame(
      encodeFrame({
        header: createFrameHeader({ type: MessageType.VideoFrame }),
        payload,
      }),
      { maxPayloadLength: payload.byteLength - 1 },
    );

    expect(allowed.ok).toBe(true);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe(ProtocolErrorCode.PayloadTooLarge);
    }
  });
});

describe("message and stream classification", () => {
  it("represents unknown message types safely", () => {
    expect(classifyMessageType(0xffff)).toEqual({
      kind: "unknown",
      value: 0xffff,
    });
  });

  it("classifies known stream and message types", () => {
    expect(classifyMessageType(MessageType.ControlText)).toEqual({
      kind: "known",
      value: MessageType.ControlText,
    });
    expect(classifyStream(StreamId.Control)).toEqual({
      kind: "known",
      value: StreamId.Control,
    });
    expect(classifyStream(999)).toEqual({
      kind: "unknown",
      value: 999,
    });
  });

  it("identifies video and control hot-path messages", () => {
    expect(isVideoMessage(MessageType.VideoConfig)).toBe(true);
    expect(isVideoMessage(MessageType.VideoFrame)).toBe(true);
    expect(isVideoMessage(MessageType.VideoReconfigure)).toBe(true);
    expect(isVideoMessage(MessageType.SessionHello)).toBe(false);
    expect(isControlMessage(MessageType.ControlPointer)).toBe(true);
    expect(isControlMessage(MessageType.ControlKey)).toBe(true);
    expect(isControlMessage(MessageType.ControlText)).toBe(true);
    expect(isControlMessage(MessageType.ControlSystem)).toBe(true);
    expect(isControlMessage(MessageType.ControlClipboard)).toBe(true);
    expect(isControlMessage(MessageType.VideoFrame)).toBe(false);
  });

  it("keeps public wire IDs aligned with the protocol draft", () => {
    expect(MessageType.SessionError).toBe(0x0005);
    expect(MessageType.DeviceInfo).toBe(0x0101);
    expect(MessageType.DeviceRotation).toBe(0x0102);
    expect(MessageType.VideoConfig).toBe(0x0201);
    expect(MessageType.VideoFrame).toBe(0x0202);
    expect(MessageType.VideoReconfigure).toBe(0x0203);
    expect(MessageType.ControlPointer).toBe(0x0301);
    expect(MessageType.ControlKey).toBe(0x0302);
    expect(MessageType.ControlText).toBe(0x0303);
    expect(MessageType.ControlSystem).toBe(0x0304);
    expect(MessageType.ControlClipboard).toBe(0x0305);
    expect(MessageType.LogRecord).toBe(0x0401);
  });

  it("exports all protocol stream IDs", () => {
    expect(StreamId.Session).toBe(1);
    expect(StreamId.Device).toBe(2);
    expect(StreamId.Video).toBe(3);
    expect(StreamId.Control).toBe(4);
    expect(StreamId.Log).toBe(5);
  });
});
