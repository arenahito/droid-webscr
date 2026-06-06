import { ProtocolFrame, encodeFrame } from "@droid-webscr/protocol";
import { readFrames } from "./stream.js";

export interface AdbDuplexLike {
  readonly chunks: AsyncIterable<Uint8Array>;
  write(chunk: Uint8Array): Promise<void> | void;
  close(): Promise<void> | void;
}

export class AdbFrameStream {
  public constructor(private readonly stream: AdbDuplexLike) {}

  public read(options = {}) {
    return readFrames(this.stream.chunks, {
      ...options,
      onDisconnect: () => this.stream.close(),
    });
  }

  public async write(frame: ProtocolFrame): Promise<void> {
    await this.stream.write(encodeFrame(frame));
  }

  public async close(): Promise<void> {
    await this.stream.close();
  }
}
