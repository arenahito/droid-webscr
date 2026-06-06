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
