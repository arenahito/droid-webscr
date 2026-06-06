import { describe, expect, it } from "vitest";
import { encodeFrame } from "@droid-webscr/protocol";
import { createFrameHeader } from "@droid-webscr/protocol";
import { MessageType } from "@droid-webscr/protocol";
import { StreamId } from "@droid-webscr/protocol";
import { FrameAssembler, readFrames } from "./stream.js";

describe("transport frame assembly", () => {
  it("assembles complete protocol frames from partial chunks", () => {
    const encoded = encodeFrame({
      header: createFrameHeader({
        sequence: 7n,
        streamId: StreamId.Video,
        timestampUs: 99n,
        type: MessageType.VideoFrame,
      }),
      payload: new Uint8Array([1, 2, 3, 4]),
    });
    const assembler = new FrameAssembler();

    expect(assembler.push(encoded.slice(0, 5))).toEqual([]);
    expect(assembler.push(encoded.slice(5, 40))).toEqual([]);
    const frames = assembler.push(encoded.slice(40));

    expect(frames).toHaveLength(1);
    expect(frames[0]?.header.sequence).toBe(7n);
    expect([...(frames[0]?.payload ?? [])]).toEqual([1, 2, 3, 4]);
    expect(assembler.bufferedBytes).toBe(0);
  });

  it("rejects buffered data growth beyond the configured limit", () => {
    const assembler = new FrameAssembler({ maxBufferedBytes: 3 });

    expect(() => assembler.push(new Uint8Array([1, 2, 3, 4]))).toThrow("Transport buffer exceeded");
    expect(assembler.bufferedBytes).toBe(0);
  });

  it("rejects declared frame length growth before waiting for more payload", () => {
    const encoded = encodeFrame({
      header: createFrameHeader({ type: MessageType.VideoFrame }),
      payload: new Uint8Array([1, 2, 3, 4]),
    });
    const assembler = new FrameAssembler({ maxBufferedBytes: encoded.byteLength - 1 });

    expect(() => assembler.push(encoded.slice(0, 40))).toThrow("Transport buffer exceeded");
    expect(assembler.bufferedBytes).toBe(0);
  });

  it("resets buffered data when a complete frame decodes as invalid", () => {
    const encoded = encodeFrame({
      header: createFrameHeader({ type: MessageType.SessionHello }),
      payload: new Uint8Array(),
    });
    encoded[3] = 0;
    const assembler = new FrameAssembler();

    expect(() => assembler.push(encoded)).toThrow("Frame magic does not match");
    expect(assembler.bufferedBytes).toBe(0);
  });

  it("passes payload limits to the protocol decoder", () => {
    const encoded = encodeFrame({
      header: createFrameHeader({ type: MessageType.VideoFrame }),
      payload: new Uint8Array([1]),
    });
    const assembler = new FrameAssembler({ maxPayloadLength: 0 });

    expect(() => assembler.push(encoded)).toThrow("Payload length 1 exceeds limit 0");
    expect(assembler.bufferedBytes).toBe(0);
  });

  it("cleans up on disconnect after yielding assembled frames", async () => {
    const encoded = encodeFrame({
      header: createFrameHeader({ type: MessageType.SessionHello }),
      payload: new Uint8Array(),
    });
    const cleanupCalls: string[] = [];

    async function* chunks() {
      yield encoded.slice(0, 12);
      yield encoded.slice(12);
    }

    const frames = [];
    for await (const frame of readFrames(chunks(), {
      onDisconnect: () => {
        cleanupCalls.push("closed");
      },
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(1);
    expect(cleanupCalls).toEqual(["closed"]);
  });
});
