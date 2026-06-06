import { DecodableVideoChunk, VideoDecoderAdapter } from "./video-pipeline.js";

export interface VideoDecoderBoundary {
  configure(config: VideoDecoderConfig): void;
  decode(chunk: EncodedVideoChunk): void;
  close(): void;
}

export function createVideoDecoderBoundary(decoder: VideoDecoder): VideoDecoderBoundary {
  return {
    close: () => decoder.close(),
    configure: (config) => decoder.configure(config),
    decode: (chunk) => decoder.decode(chunk),
  };
}

/* v8 ignore start -- native WebCodecs construction requires a real Chromium runtime; pipeline behavior is covered through typed adapter tests */
export function createNativeVideoDecoderAdapter(
  output: (frame: VideoFrame) => void,
  error: (error: Error) => void,
): VideoDecoderAdapter | undefined {
  if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") {
    return undefined;
  }
  return new NativeVideoDecoderAdapter(new VideoDecoder({ error, output }));
}

class NativeVideoDecoderAdapter implements VideoDecoderAdapter {
  public constructor(private readonly decoder: VideoDecoder) {}

  public get decodeQueueSize(): number {
    return this.decoder.decodeQueueSize;
  }

  public close(): void {
    this.decoder.close();
  }

  public configure(config: VideoDecoderConfig): void {
    this.decoder.configure(config);
  }

  public decode(chunk: DecodableVideoChunk): void {
    this.decoder.decode(
      new EncodedVideoChunk({
        data: chunk.data,
        timestamp: chunk.timestamp,
        type: chunk.type,
      }),
    );
  }

  public reset(): void {
    this.decoder.reset();
  }
}
/* v8 ignore stop */
