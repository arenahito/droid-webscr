export * from "./codec.js";
export * from "./control.js";
export * from "./errors.js";
export * from "./frame.js";
export * from "./messages.js";
export * from "./sequence.js";
export * from "./streams.js";
export * from "./video.js";

export function describeProtocol(): string {
  return "DWSC/v1";
}
