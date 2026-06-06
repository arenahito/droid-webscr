export type TransportState = "idle" | "connecting" | "open" | "closed";

export function canSend(state: TransportState): boolean {
  return state === "open";
}
