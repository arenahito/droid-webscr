import { createFrameHeader, encodeFrame, MessageType, StreamId } from "@droid-webscr/protocol";
import { describe, expect, it } from "vitest";
import { createVideoPipeline, VideoDecoderAdapter } from "./video-pipeline.js";

describe("video pipeline", () => {
  it("configures the decoder from VIDEO_CONFIG and decodes video chunks", async () => {
    const adapter = new RecordingVideoDecoderAdapter();
    const pipeline = createVideoPipeline({ createDecoder: () => adapter });

    await pipeline.acceptFrame(
      createVideoConfigFrame(720, 1280, [0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1e]),
    );
    await pipeline.acceptFrame(createVideoFrame([0, 0, 1], true, 33n));

    expect(adapter.configs).toHaveLength(1);
    expect(adapter.configs[0]?.codec).toBe("avc1.42E01E");
    expect(adapter.configs[0]?.codedHeight).toBe(1280);
    expect(adapter.configs[0]?.codedWidth).toBe(720);
    expect(adapter.configs[0]?.description).toBeUndefined();
    expect(adapter.chunks).toEqual([
      {
        data: new Uint8Array([0, 0, 1]),
        timestamp: 33,
        type: "key",
      },
    ]);
    expect(pipeline.snapshot()).toEqual({
      configured: true,
      decodedFrames: 1,
      droppedFrames: 0,
      lastError: undefined,
      pressure: false,
      status: "ready",
      videoSize: { height: 1280, width: 720 },
    });

    await pipeline.acceptFrame(createVideoFrame([5], false, 34n));
    expect(adapter.chunks.at(-1)).toEqual({
      data: new Uint8Array([5]),
      timestamp: 34,
      type: "delta",
    });
  });

  it("bounds decode pressure and avoids unbounded queued chunks", async () => {
    const adapter = new RecordingVideoDecoderAdapter();
    adapter.decodeQueueSize = 2;
    const pipeline = createVideoPipeline({ createDecoder: () => adapter, maxDecodeQueueSize: 2 });

    await pipeline.acceptFrame(createVideoConfigFrame(720, 1280, []));
    await pipeline.acceptFrame(createVideoFrame([9], false, 1n));

    expect(adapter.chunks).toEqual([]);
    expect(pipeline.snapshot().pressure).toBe(true);
    expect(pipeline.snapshot().droppedFrames).toBe(1);
  });

  it("resets decoder state and closes resources", async () => {
    const adapter = new RecordingVideoDecoderAdapter();
    const pipeline = createVideoPipeline({ createDecoder: () => adapter });

    await pipeline.acceptFrame(createVideoConfigFrame(720, 1280, []));
    pipeline.reset();
    pipeline.close();

    expect(adapter.resetCount).toBe(1);
    expect(adapter.closeCount).toBe(1);
    expect(pipeline.snapshot().configured).toBe(false);
    expect(pipeline.snapshot().status).toBe("closed");
  });

  it("reports unsupported WebCodecs states without throwing", async () => {
    const pipeline = createVideoPipeline({ createDecoder: undefined });
    const factoryReturnedUnsupported = createVideoPipeline({ createDecoder: () => undefined });

    await pipeline.acceptFrame(createVideoConfigFrame(720, 1280, []));
    await factoryReturnedUnsupported.acceptFrame(createVideoConfigFrame(720, 1280, []));

    expect(pipeline.snapshot()).toMatchObject({
      configured: false,
      status: "unsupported",
    });
    expect(factoryReturnedUnsupported.snapshot().status).toBe("unsupported");
    expect(pipeline.snapshot().lastError).toContain("WebCodecs VideoDecoder is unavailable");
  });

  it("reports malformed frame and ordering errors", async () => {
    const adapter = new RecordingVideoDecoderAdapter();
    const pipeline = createVideoPipeline({ createDecoder: () => adapter });

    await pipeline.acceptFrame(new Uint8Array([1, 2, 3]));
    expect(pipeline.snapshot().status).toBe("error");

    pipeline.reset();
    await pipeline.acceptFrame(createVideoFrame([0], false, 1n));
    expect(pipeline.snapshot().lastError).toBe("VIDEO_FRAME arrived before VIDEO_CONFIG.");

    const unsupported = createVideoPipeline({ createDecoder: undefined });
    await unsupported.acceptFrame(createVideoFrame([0], false, 1n));
    expect(unsupported.snapshot().status).toBe("unsupported");
  });

  it("contains adapter failures as pipeline errors", async () => {
    const pipeline = createVideoPipeline({
      createDecoder: () => ({
        close: () => {},
        configure: () => {
          throw "configure failed";
        },
        decode: () => {},
        decodeQueueSize: 0,
        reset: () => {},
      }),
    });

    await pipeline.acceptFrame(createVideoConfigFrame(720, 1280, []));

    expect(pipeline.snapshot().status).toBe("error");
    expect(pipeline.snapshot().lastError).toBe("Video pipeline failed.");

    const errorPipeline = createVideoPipeline({
      createDecoder: () => ({
        close: () => {},
        configure: () => {
          throw new Error("configure exploded");
        },
        decode: () => {},
        decodeQueueSize: 0,
        reset: () => {},
      }),
    });

    await errorPipeline.acceptFrame(createVideoConfigFrame(720, 1280, []));

    expect(errorPipeline.snapshot().lastError).toBe("configure exploded");
  });

  it("ignores non-video frames after decoding the envelope", async () => {
    const adapter = new RecordingVideoDecoderAdapter();
    const pipeline = createVideoPipeline({ createDecoder: () => adapter });

    await pipeline.acceptFrame(
      encodeFrame({
        header: createFrameHeader({
          streamId: StreamId.Session,
          type: MessageType.SessionHelloAck,
        }),
        payload: new Uint8Array(),
      }),
    );

    expect(pipeline.snapshot().status).toBe("idle");
  });
});

class RecordingVideoDecoderAdapter implements VideoDecoderAdapter {
  public readonly chunks: Array<{
    readonly data: Uint8Array;
    readonly timestamp: number;
    readonly type: "key" | "delta";
  }> = [];
  public readonly configs: VideoDecoderConfig[] = [];
  public closeCount = 0;
  public decodeQueueSize = 0;
  public resetCount = 0;

  public close(): void {
    this.closeCount += 1;
  }

  public configure(config: VideoDecoderConfig): void {
    this.configs.push(config);
  }

  public decode(chunk: {
    readonly data: Uint8Array;
    readonly timestamp: number;
    readonly type: "key" | "delta";
  }): void {
    this.chunks.push(chunk);
  }

  public reset(): void {
    this.resetCount += 1;
  }
}

function createVideoConfigFrame(width: number, height: number, configBytes: readonly number[]) {
  const actualConfigBytes =
    configBytes.length === 0 ? [0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1e] : configBytes;
  const payload = new Uint8Array(16 + actualConfigBytes.length);
  const view = new DataView(payload.buffer);
  view.setUint8(0, 1);
  view.setUint8(1, 1);
  view.setUint32(4, width, false);
  view.setUint32(8, height, false);
  view.setUint32(12, actualConfigBytes.length, false);
  payload.set(actualConfigBytes, 16);
  return encodeFrame({
    header: createFrameHeader({
      payloadLength: payload.byteLength,
      streamId: StreamId.Video,
      type: MessageType.VideoConfig,
    }),
    payload,
  });
}

function createVideoFrame(bytes: readonly number[], keyFrame: boolean, timestampUs: bigint) {
  return encodeFrame({
    header: createFrameHeader({
      flags: keyFrame ? 1 : 0,
      payloadLength: bytes.length,
      streamId: StreamId.Video,
      timestampUs,
      type: MessageType.VideoFrame,
    }),
    payload: new Uint8Array(bytes),
  });
}
