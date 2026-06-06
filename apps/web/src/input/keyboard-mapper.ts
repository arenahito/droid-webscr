import { createKeyControlFrame } from "@droid-webscr/protocol";

export type KeyAction = "down" | "up";

export interface KeyboardControlInput {
  readonly action: KeyAction;
  readonly code: string;
  readonly metaState: number;
  readonly repeat: number;
  readonly sequence?: bigint | undefined;
}

const androidKeycodes = new Map<string, number>([
  ["Backspace", 67],
  ["Enter", 66],
  ["Escape", 111],
  ["ArrowUp", 19],
  ["ArrowDown", 20],
  ["ArrowLeft", 21],
  ["ArrowRight", 22],
  ["Space", 62],
]);

export function mapKeyboardToControlFrame(input: KeyboardControlInput): Uint8Array | undefined {
  const keycode = androidKeycodes.get(input.code);
  if (keycode === undefined) {
    return undefined;
  }

  return createKeyControlFrame({
    action: input.action,
    keyCode: keycode,
    metaState: input.metaState,
    repeat: input.repeat,
    sequence: input.sequence,
  });
}
