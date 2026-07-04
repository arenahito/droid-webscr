export interface StartedDeviceSession {
  readonly frames: AsyncIterable<Uint8Array>;
  readonly serial: string;
  shell?(command: readonly string[]): Promise<number>;
  stop(): Promise<void>;
  write(frame: Uint8Array): Promise<void>;
}
