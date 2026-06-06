export enum StreamId {
  Session = 1,
  Device = 2,
  Video = 3,
  Control = 4,
  Log = 5,
}

export type ClassifiedStream =
  | { readonly kind: "known"; readonly value: StreamId }
  | { readonly kind: "unknown"; readonly value: number };

const knownStreams = new Set<number>(
  Object.values(StreamId).filter((value) => typeof value === "number"),
);

export function classifyStream(value: number): ClassifiedStream {
  if (knownStreams.has(value)) {
    return { kind: "known", value: value as StreamId };
  }

  return { kind: "unknown", value };
}
