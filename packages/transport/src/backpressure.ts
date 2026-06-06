import { ProtocolFrame } from "@droid-webscr/protocol";

export const VIDEO_KEYFRAME_FLAG = 1 << 0;

export interface BackpressureOptions {
  readonly maxQueuedFrames: number;
}

export interface BackpressureResult {
  readonly dropped: readonly ProtocolFrame[];
  readonly kept: readonly ProtocolFrame[];
}

export function applyBackpressure(
  frames: readonly ProtocolFrame[],
  options: BackpressureOptions,
): BackpressureResult {
  if (options.maxQueuedFrames < 0) {
    throw new Error("maxQueuedFrames must be non-negative.");
  }

  const kept = [...frames];
  const dropped: ProtocolFrame[] = [];

  while (kept.length > options.maxQueuedFrames) {
    const dropIndex = firstNonKeyframeIndex(kept) ?? 0;
    const [removed] = kept.splice(dropIndex, 1);
    dropped.push(removed as ProtocolFrame);
  }

  return { dropped, kept };
}

function firstNonKeyframeIndex(frames: readonly ProtocolFrame[]): number | undefined {
  const index = frames.findIndex((frame) => (frame.header.flags & VIDEO_KEYFRAME_FLAG) === 0);
  return index === -1 ? undefined : index;
}
