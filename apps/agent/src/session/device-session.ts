export interface StartedDeviceSession {
  readonly frames: AsyncIterable<Uint8Array>;
  readonly serial: string;
  stop(): Promise<void>;
  write(frame: Uint8Array): Promise<void>;
}
