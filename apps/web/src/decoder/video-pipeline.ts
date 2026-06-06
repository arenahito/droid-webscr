import {
  decodeFrame,
  MessageType,
  parseVideoConfigFrame,
  parseVideoFrame,
} from "@droid-webscr/protocol";
import { createWebCodecsH264Config } from "./h264-config.js";

export type VideoPipelineStatus = "idle" | "ready" | "unsupported" | "error" | "closed";

export interface DecodableVideoChunk {
  readonly data: Uint8Array;
  readonly timestamp: number;
  readonly type: "key" | "delta";
}

export interface VideoDecoderAdapter {
  readonly decodeQueueSize: number;
  close(): void;
  configure(config: VideoDecoderConfig): void | Promise<void>;
  decode(chunk: DecodableVideoChunk): void;
  reset(): void;
}

export interface VideoPipelineSnapshot {
  readonly configured: boolean;
  readonly decodedFrames: number;
  readonly droppedFrames: number;
  readonly lastError: string | undefined;
  readonly pressure: boolean;
  readonly status: VideoPipelineStatus;
  readonly videoSize: { readonly height: number; readonly width: number } | undefined;
}

export interface VideoPipelineOptions {
  readonly createDecoder: (() => VideoDecoderAdapter | undefined) | undefined;
  readonly maxDecodeQueueSize?: number | undefined;
  readonly onVideoConfig?:
    | ((size: { readonly height: number; readonly width: number }) => void)
    | undefined;
}

export interface VideoPipeline {
  acceptFrame(frame: Uint8Array): Promise<VideoPipelineSnapshot>;
  close(): void;
  reset(): void;
  snapshot(): VideoPipelineSnapshot;
}

export function createVideoPipeline(options: VideoPipelineOptions): VideoPipeline {
  const maxDecodeQueueSize = options.maxDecodeQueueSize ?? 4;
  let configured = false;
  let decodedFrames = 0;
  let droppedFrames = 0;
  let lastError: string | undefined;
  let pressure = false;
  let status: VideoPipelineStatus = "idle";
  let videoSize: { readonly height: number; readonly width: number } | undefined;
  let decoder: VideoDecoderAdapter | undefined;

  const getDecoder = (): VideoDecoderAdapter | undefined => {
    if (decoder) {
      return decoder;
    }
    if (!options.createDecoder) {
      status = "unsupported";
      lastError = "WebCodecs VideoDecoder is unavailable in this browser.";
      return undefined;
    }
    decoder = options.createDecoder();
    if (!decoder) {
      status = "unsupported";
      lastError = "WebCodecs VideoDecoder is unavailable in this browser.";
      return undefined;
    }
    return decoder;
  };

  const snapshot = (): VideoPipelineSnapshot => ({
    configured,
    decodedFrames,
    droppedFrames,
    lastError,
    pressure,
    status,
    videoSize,
  });

  return {
    acceptFrame: async (bytes) => {
      const decoded = decodeFrame(bytes);
      if (!decoded.ok) {
        status = "error";
        lastError = decoded.error.message;
        return snapshot();
      }

      try {
        if (decoded.value.header.type === MessageType.VideoConfig) {
          const config = parseVideoConfigFrame(decoded.value);
          const activeDecoder = getDecoder();
          if (!activeDecoder) {
            return snapshot();
          }
          await activeDecoder.configure({
            ...createWebCodecsH264Config({
              codecConfig: config.codecConfig,
              height: config.codedHeight,
              width: config.codedWidth,
            }),
          });
          configured = true;
          videoSize = { height: config.codedHeight, width: config.codedWidth };
          options.onVideoConfig?.(videoSize);
          status = "ready";
          lastError = undefined;
          return snapshot();
        }

        if (decoded.value.header.type === MessageType.VideoFrame) {
          const activeDecoder = getDecoder();
          if (!activeDecoder) {
            return snapshot();
          }
          if (!configured) {
            status = "error";
            lastError = "VIDEO_FRAME arrived before VIDEO_CONFIG.";
            return snapshot();
          }
          if (activeDecoder.decodeQueueSize >= maxDecodeQueueSize) {
            pressure = true;
            droppedFrames += 1;
            return snapshot();
          }
          const frame = parseVideoFrame(decoded.value);
          activeDecoder.decode({
            data: frame.data,
            timestamp: Number(frame.timestampUs),
            type: frame.keyFrame ? "key" : "delta",
          });
          decodedFrames += 1;
          pressure = activeDecoder.decodeQueueSize >= maxDecodeQueueSize;
        }
      } catch (error) {
        status = "error";
        lastError = error instanceof Error ? error.message : "Video pipeline failed.";
      }
      return snapshot();
    },
    close: () => {
      decoder?.close();
      status = "closed";
    },
    reset: () => {
      decoder?.reset();
      configured = false;
      pressure = false;
      status = "idle";
      videoSize = undefined;
    },
    snapshot,
  };
}
