import { DecodableVideoChunk, VideoDecoderAdapter } from "./video-pipeline.js";

export interface VideoDecoderBoundary {
  configure(config: VideoDecoderConfig): void;
  decode(chunk: EncodedVideoChunk): void;
  close(): void;
}

export function createVideoDecoderBoundary(decoder: VideoDecoder): VideoDecoderBoundary {
  let closed = decoder.state === "closed";
  return {
    close: () => {
      if (closed || decoder.state === "closed") {
        closed = true;
        return;
      }
      closed = true;
      decoder.close();
    },
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
  private readonly boundary: VideoDecoderBoundary;

  public constructor(private readonly decoder: VideoDecoder) {
    this.boundary = createVideoDecoderBoundary(decoder);
  }

  public get decodeQueueSize(): number {
    return this.decoder.decodeQueueSize;
  }

  public close(): void {
    this.boundary.close();
  }

  public configure(config: VideoDecoderConfig): void {
    this.boundary.configure(config);
  }

  public decode(chunk: DecodableVideoChunk): void {
    this.boundary.decode(
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
