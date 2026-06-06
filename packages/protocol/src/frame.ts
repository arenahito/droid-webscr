import { MessageType } from "./messages.js";
import { StreamId } from "./streams.js";

export const FRAME_MAGIC = 0x44575343;
export const FRAME_HEADER_LENGTH = 40;
export const WIRE_VERSION = 1;
export const DEFAULT_MAX_PAYLOAD_LENGTH = 16 * 1024 * 1024;

export interface FrameHeader {
  readonly magic: number;
  readonly version: number;
  readonly headerLength: number;
  readonly type: number;
  readonly flags: number;
  readonly streamId: number;
  readonly payloadLength: number;
  readonly timestampUs: bigint;
  readonly sequence: bigint;
  readonly reserved: number;
}

export interface CreateFrameHeaderInput {
  readonly type: MessageType | number;
  readonly flags?: number;
  readonly streamId?: StreamId | number;
  readonly payloadLength?: number;
  readonly timestampUs?: bigint;
  readonly sequence?: bigint;
  readonly reserved?: number;
}

export function createFrameHeader(input: CreateFrameHeaderInput): FrameHeader {
  return {
    flags: input.flags ?? 0,
    headerLength: FRAME_HEADER_LENGTH,
    magic: FRAME_MAGIC,
    payloadLength: input.payloadLength ?? 0,
    reserved: input.reserved ?? 0,
    sequence: input.sequence ?? 0n,
    streamId: input.streamId ?? StreamId.Session,
    timestampUs: input.timestampUs ?? 0n,
    type: input.type,
    version: WIRE_VERSION,
  };
}
