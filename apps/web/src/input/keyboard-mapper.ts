import { createFrameHeader, encodeFrame, MessageType, StreamId } from "@droid-webscr/protocol";

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

  const payload = new Uint8Array(12);
  const view = new DataView(payload.buffer);
  view.setUint8(0, input.action === "down" ? 1 : 2);
  view.setUint16(2, keycode, false);
  view.setUint32(4, input.metaState, false);
  view.setUint32(8, input.repeat, false);

  return encodeFrame({
    header: createFrameHeader({
      payloadLength: payload.byteLength,
      ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
      streamId: StreamId.Control,
      type: MessageType.ControlKey,
    }),
    payload,
  });
}
