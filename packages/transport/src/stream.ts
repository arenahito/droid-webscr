import {
  DecodeFrameOptions,
  FRAME_HEADER_LENGTH,
  ProtocolFrame,
  decodeFrame,
} from "@droid-webscr/protocol";

export interface FrameAssemblerOptions extends DecodeFrameOptions {
  readonly maxBufferedBytes?: number;
}

export interface ReadFramesOptions extends FrameAssemblerOptions {
  readonly onDisconnect?: () => Promise<void> | void;
}

const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

export class FrameAssembler {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private readonly maxBufferedBytes: number;
  private readonly decodeOptions: DecodeFrameOptions;

  public constructor(options: FrameAssemblerOptions = {}) {
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.decodeOptions =
      options.maxPayloadLength === undefined ? {} : { maxPayloadLength: options.maxPayloadLength };
  }

  public get bufferedBytes(): number {
    return this.buffer.byteLength;
  }

  public push(chunk: Uint8Array): ProtocolFrame[] {
    this.buffer = concat(this.buffer, chunk);
    if (this.buffer.byteLength > this.maxBufferedBytes) {
      this.reset();
      throw new Error("Transport buffer exceeded the configured limit.");
    }

    const frames: ProtocolFrame[] = [];
    while (this.buffer.byteLength >= FRAME_HEADER_LENGTH) {
      const payloadLength = readPayloadLength(this.buffer);
      const frameLength = FRAME_HEADER_LENGTH + payloadLength;
      if (frameLength > this.maxBufferedBytes) {
        this.reset();
        throw new Error("Transport buffer exceeded the configured limit.");
      }
      if (this.buffer.byteLength < frameLength) {
        break;
      }

      const frameBytes = this.buffer.slice(0, frameLength);
      const decoded = decodeFrame(frameBytes, this.decodeOptions);
      if (!decoded.ok) {
        this.reset();
        throw decoded.error;
      }

      frames.push(decoded.value);
      this.buffer = this.buffer.slice(frameLength);
    }

    return frames;
  }

  public reset(): void {
    this.buffer = new Uint8Array();
  }
}

export async function* readFrames(
  chunks: AsyncIterable<Uint8Array>,
  options: ReadFramesOptions = {},
): AsyncGenerator<ProtocolFrame> {
  const assembler = new FrameAssembler(options);
  try {
    for await (const chunk of chunks) {
      for (const frame of assembler.push(chunk)) {
        yield frame;
      }
    }
  } finally {
    assembler.reset();
    await options.onDisconnect?.();
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left, 0);
  output.set(right, left.byteLength);
  return output;
}

function readPayloadLength(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(16, false);
}
