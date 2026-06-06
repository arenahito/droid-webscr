export * from "./codec.js";
export * from "./errors.js";
export * from "./frame.js";
export * from "./messages.js";
export * from "./sequence.js";
export * from "./streams.js";

export function describeProtocol(): string {
  return "DWSC/v1";
}
