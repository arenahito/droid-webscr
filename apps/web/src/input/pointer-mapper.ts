import { createPointerControlFrame } from "@droid-webscr/protocol";

export type PointerAction = "down" | "move" | "up" | "cancel";

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
  if (input.viewport.width <= 0 || input.viewport.height <= 0) {
    throw new Error("Viewport dimensions must be positive.");
  }
  const x = clampToInt(input.x - input.viewport.left, 0, input.viewport.width);
  const y = clampToInt(input.y - input.viewport.top, 0, input.viewport.height);
  return createPointerControlFrame({
    action: input.action,
    buttons: input.buttons,
    pointerId: input.pointerId,
    pressure: input.pressure,
    sequence: input.sequence,
    x: clampToInt(
      Math.round((x / input.viewport.width) * input.display.width),
      0,
      input.display.width - 1,
    ),
    y: clampToInt(
      Math.round((y / input.viewport.height) * input.display.height),
      0,
      input.display.height - 1,
    ),
  });
}

function clampToInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
