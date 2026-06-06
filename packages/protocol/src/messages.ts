export enum MessageType {
  SessionHello = 0x0001,
  SessionHelloAck = 0x0002,
  SessionStart = 0x0003,
  SessionStop = 0x0004,
  SessionError = 0x0005,
  DeviceInfo = 0x0101,
  DeviceRotation = 0x0102,
  VideoConfig = 0x0201,
  VideoFrame = 0x0202,
  VideoReconfigure = 0x0203,
  ControlPointer = 0x0301,
  ControlKey = 0x0302,
  ControlText = 0x0303,
  ControlSystem = 0x0304,
  ControlClipboard = 0x0305,
  LogRecord = 0x0401,
}

export type ClassifiedMessageType =
  | { readonly kind: "known"; readonly value: MessageType }
  | { readonly kind: "unknown"; readonly value: number };

const knownMessageTypes = new Set<number>(
  Object.values(MessageType).filter((value) => typeof value === "number"),
);

export function classifyMessageType(value: number): ClassifiedMessageType {
  if (knownMessageTypes.has(value)) {
    return { kind: "known", value: value as MessageType };
  }

  return { kind: "unknown", value };
}

export function isControlMessage(type: MessageType): boolean {
  return (
    type === MessageType.ControlPointer ||
    type === MessageType.ControlKey ||
    type === MessageType.ControlText ||
    type === MessageType.ControlSystem ||
    type === MessageType.ControlClipboard
  );
}

export function isVideoMessage(type: MessageType): boolean {
  return (
    type === MessageType.VideoConfig ||
    type === MessageType.VideoFrame ||
    type === MessageType.VideoReconfigure
  );
}
