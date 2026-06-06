import { createFrameHeader, encodeFrame, MessageType, StreamId } from "@droid-webscr/protocol";

export type PointerAction = "down" | "move" | "up";

export interface DisplaySize {
  readonly height: number;
  readonly rotation: 0 | 90 | 180 | 270;
  readonly width: number;
}

export interface ViewportRect {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

export interface PointerControlInput {
  readonly action: PointerAction;
  readonly buttons: number;
  readonly display: DisplaySize;
  readonly pointerId: number;
  readonly pressure: number;
  readonly sequence?: bigint | undefined;
  readonly viewport: ViewportRect;
  readonly x: number;
  readonly y: number;
}

export function fitViewport(
  display: DisplaySize,
  container: { readonly height: number; readonly width: number },
): { readonly height: number; readonly width: number } {
  const displayWidth = display.width;
  const displayHeight = display.height;
  const scale = Math.min(container.width / displayWidth, container.height / displayHeight);
  return {
    height: Math.round(displayHeight * scale),
    width: Math.round(displayWidth * scale),
  };
}

export function mapPointerToControlFrame(input: PointerControlInput): Uint8Array {
  const x = clampToInt(input.x - input.viewport.left, 0, input.viewport.width);
  const y = clampToInt(input.y - input.viewport.top, 0, input.viewport.height);
  const deviceX = Math.round((x / input.viewport.width) * input.display.width);
  const deviceY = Math.round((y / input.viewport.height) * input.display.height);
  const payload = new Uint8Array(20);
  const view = new DataView(payload.buffer);

  view.setUint8(0, encodePointerAction(input.action));
  view.setUint16(2, input.pointerId, false);
  view.setUint32(4, deviceX, false);
  view.setUint32(8, deviceY, false);
  view.setUint8(12, Math.round(clamp(input.pressure, 0, 1) * 255));
  view.setUint16(14, input.buttons, false);
  view.setUint32(16, 0, false);

  return encodeFrame({
    header: createFrameHeader({
      payloadLength: payload.byteLength,
      ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
      streamId: StreamId.Control,
      type: MessageType.ControlPointer,
    }),
    payload,
  });
}

function encodePointerAction(action: PointerAction): number {
  if (action === "down") {
    return 1;
  }
  if (action === "move") {
    return 2;
  }
  return 3;
}

function clampToInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
