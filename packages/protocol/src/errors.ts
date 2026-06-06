export enum ProtocolErrorCode {
  FrameTooShort = "FRAME_TOO_SHORT",
  InvalidMagic = "INVALID_MAGIC",
  UnsupportedVersion = "UNSUPPORTED_VERSION",
  UnsupportedHeaderLength = "UNSUPPORTED_HEADER_LENGTH",
  PayloadLengthMismatch = "PAYLOAD_LENGTH_MISMATCH",
  PayloadTooLarge = "PAYLOAD_TOO_LARGE",
}

export class ProtocolError extends Error {
  public readonly code: ProtocolErrorCode;

  public constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

export function isProtocolError(error: unknown): error is ProtocolError {
  return error instanceof ProtocolError;
}
