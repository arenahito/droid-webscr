import {
  DEFAULT_MAX_PAYLOAD_LENGTH,
  FRAME_HEADER_LENGTH,
  FRAME_MAGIC,
  FrameHeader,
  WIRE_VERSION,
} from "./frame.js";
import { ProtocolError, ProtocolErrorCode, isProtocolError } from "./errors.js";

export { ProtocolErrorCode, isProtocolError };

export interface ProtocolFrame {
  readonly header: FrameHeader;
  readonly payload: Uint8Array;
}

export interface DecodeFrameOptions {
  readonly maxPayloadLength?: number;
}

export type DecodeFrameResult =
  | { readonly ok: true; readonly value: ProtocolFrame }
  | { readonly ok: false; readonly error: ProtocolError };

export function encodeFrame(frame: ProtocolFrame): Uint8Array {
  const payloadLength = frame.payload.byteLength;
  const output = new Uint8Array(FRAME_HEADER_LENGTH + payloadLength);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);

  view.setUint32(0, FRAME_MAGIC, false);
  view.setUint16(4, frame.header.version, false);
  view.setUint16(6, frame.header.headerLength, false);
  view.setUint16(8, frame.header.type, false);
  view.setUint16(10, frame.header.flags, false);
  view.setUint32(12, frame.header.streamId, false);
  view.setUint32(16, payloadLength, false);
  view.setBigUint64(20, frame.header.timestampUs, false);
  view.setBigUint64(28, frame.header.sequence, false);
  view.setUint32(36, frame.header.reserved, false);
  output.set(frame.payload, FRAME_HEADER_LENGTH);

  return output;
}

export function decodeFrame(
  bytes: Uint8Array,
  options: DecodeFrameOptions = {},
): DecodeFrameResult {
  const maxPayloadLength = options.maxPayloadLength ?? DEFAULT_MAX_PAYLOAD_LENGTH;

  if (bytes.byteLength < FRAME_HEADER_LENGTH) {
    return failure(ProtocolErrorCode.FrameTooShort, "Frame is shorter than the protocol header.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, false);
  if (magic !== FRAME_MAGIC) {
    return failure(ProtocolErrorCode.InvalidMagic, "Frame magic does not match DWSC.");
  }

  const version = view.getUint16(4, false);
  if (version !== WIRE_VERSION) {
    return failure(ProtocolErrorCode.UnsupportedVersion, `Unsupported wire version: ${version}.`);
  }

  const headerLength = view.getUint16(6, false);
  if (headerLength !== FRAME_HEADER_LENGTH) {
    return failure(
      ProtocolErrorCode.UnsupportedHeaderLength,
      `Unsupported header length: ${headerLength}.`,
    );
  }

  const payloadLength = view.getUint32(16, false);
  if (payloadLength > maxPayloadLength) {
    return failure(
      ProtocolErrorCode.PayloadTooLarge,
      `Payload length ${payloadLength} exceeds limit ${maxPayloadLength}.`,
    );
  }

  const expectedLength = FRAME_HEADER_LENGTH + payloadLength;
  if (bytes.byteLength !== expectedLength) {
    return failure(
      ProtocolErrorCode.PayloadLengthMismatch,
      `Frame length ${bytes.byteLength} does not match declared length ${expectedLength}.`,
    );
  }

  return {
    ok: true,
    value: {
      header: {
        flags: view.getUint16(10, false),
        headerLength,
        magic,
        payloadLength,
        reserved: view.getUint32(36, false),
        sequence: view.getBigUint64(28, false),
        streamId: view.getUint32(12, false),
        timestampUs: view.getBigUint64(20, false),
        type: view.getUint16(8, false),
        version,
      },
      payload: bytes.slice(FRAME_HEADER_LENGTH),
    },
  };
}

function failure(code: ProtocolErrorCode, message: string): DecodeFrameResult {
  return {
    error: new ProtocolError(code, message),
    ok: false,
  };
}
