import { createFrameHeader } from "./frame.js";
import { encodeFrame } from "./codec.js";
import { MessageType } from "./messages.js";
import { StreamId } from "./streams.js";

export type PointerControlAction = "down" | "move" | "up" | "cancel";
export type KeyControlAction = "down" | "up";
export type SystemControlAction =
  | "back"
  | "home"
  | "overview"
  | "volume-up"
  | "volume-down"
  | "power"
  | "keyboard";
export type ClipboardControlAction = "set" | "get";

export interface ControlFrameOptions {
  readonly sequence?: bigint | undefined;
  readonly timestampUs?: bigint | undefined;
}

export interface PointerControlPayloadInput extends ControlFrameOptions {
  readonly action: PointerControlAction;
  readonly buttons: number;
  readonly displayId?: number | undefined;
  readonly pointerId: number;
  readonly pressure: number;
  readonly x: number;
  readonly y: number;
}

export interface KeyControlPayloadInput extends ControlFrameOptions {
  readonly action: KeyControlAction;
  readonly keyCode: number;
  readonly metaState: number;
  readonly repeat: number;
}

export interface TextControlPayloadInput extends ControlFrameOptions {
  readonly text: string;
}

export interface ClipboardControlPayloadInput extends ControlFrameOptions {
  readonly action: ClipboardControlAction;
  readonly text?: string | undefined;
}

export function createPointerControlFrame(input: PointerControlPayloadInput): Uint8Array {
  const payload = new Uint8Array(20);
  const view = new DataView(payload.buffer);
  view.setUint8(0, encodePointerAction(input.action));
  view.setUint16(2, input.pointerId, false);
  view.setUint32(4, input.x, false);
  view.setUint32(8, input.y, false);
  view.setUint8(12, Math.round(clamp(input.pressure, 0, 1) * 255));
  view.setUint16(14, input.buttons, false);
  view.setUint32(16, input.displayId ?? 0, false);
  return createControlFrame(MessageType.ControlPointer, payload, input);
}

export function createKeyControlFrame(input: KeyControlPayloadInput): Uint8Array {
  const payload = new Uint8Array(12);
  const view = new DataView(payload.buffer);
  view.setUint8(0, input.action === "down" ? 0 : 1);
  view.setUint16(2, input.keyCode, false);
  view.setUint32(4, input.metaState, false);
  view.setUint32(8, input.repeat, false);
  return createControlFrame(MessageType.ControlKey, payload, input);
}

export function createTextControlFrame(input: TextControlPayloadInput): Uint8Array {
  return createControlFrame(MessageType.ControlText, new TextEncoder().encode(input.text), input);
}

export function createSystemControlFrame(
  action: SystemControlAction,
  options: ControlFrameOptions = {},
): Uint8Array {
  return createControlFrame(
    MessageType.ControlSystem,
    new Uint8Array([encodeSystemAction(action)]),
    options,
  );
}

export function createClipboardControlFrame(input: ClipboardControlPayloadInput): Uint8Array {
  const text = new TextEncoder().encode(input.text ?? "");
  const payload = new Uint8Array(1 + text.byteLength);
  payload[0] = input.action === "set" ? 0 : 1;
  payload.set(text, 1);
  return createControlFrame(MessageType.ControlClipboard, payload, input);
}

function createControlFrame(
  type: MessageType,
  payload: Uint8Array,
  options: ControlFrameOptions,
): Uint8Array {
  return encodeFrame({
    header: createFrameHeader({
      payloadLength: payload.byteLength,
      streamId: StreamId.Control,
      type,
      ...(options.sequence === undefined ? {} : { sequence: options.sequence }),
      ...(options.timestampUs === undefined ? {} : { timestampUs: options.timestampUs }),
    }),
    payload,
  });
}

function encodePointerAction(action: PointerControlAction): number {
  switch (action) {
    case "down":
      return 0;
    case "move":
      return 1;
    case "up":
      return 2;
    case "cancel":
      return 3;
  }
}

function encodeSystemAction(action: SystemControlAction): number {
  switch (action) {
    case "back":
      return 0;
    case "home":
      return 1;
    case "overview":
      return 2;
    case "volume-up":
      return 3;
    case "volume-down":
      return 4;
    case "power":
      return 5;
    case "keyboard":
      return 6;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
