import { Readable } from "node:stream";

export enum AdbAuthorizationState {
  Authorized = "authorized",
  Offline = "offline",
  Unauthorized = "unauthorized",
}

export enum AdbTransportKind {
  Emulator = "emulator",
  Network = "network",
  Usb = "usb",
}

export interface AdbDeviceDescriptor {
  readonly authorizationState: AdbAuthorizationState;
  readonly model?: string | undefined;
  readonly serial: string;
  readonly transportKind: AdbTransportKind;
}

export interface AdbShellProcess {
  readonly command: readonly string[];
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly exit: Promise<number>;
}

export interface AdbLogTail {
  readonly lines: AsyncIterable<string>;
  close(): Promise<void>;
}

export interface AdbDeviceSession {
  readonly serial: string;
  close(): Promise<void>;
  openSocket(name: string): Promise<AdbSocket>;
  push(localPath: string, remotePath: string): Promise<void>;
  shell(command: readonly string[]): Promise<AdbShellProcess>;
}

export interface AdbSocket {
  readonly chunks: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
  write(chunk: Uint8Array): Promise<void>;
}

export interface AdbProvider {
  connectEndpoint?(endpoint: string): Promise<void>;
  connect(serial: string): Promise<AdbDeviceSession>;
  disconnect?(serial: string): Promise<void>;
  listDevices(): Promise<AdbDeviceDescriptor[]>;
  readDeviceLogs(serial: string, lines: number): Promise<readonly string[]>;
  tailDeviceLogs(serial: string): Promise<AdbLogTail>;
}

export function isUsableDevice(device: AdbDeviceDescriptor): boolean {
  return device.authorizationState === AdbAuthorizationState.Authorized && device.serial.length > 0;
}

export class FakeAdbProvider implements AdbProvider {
  private readonly devices: readonly AdbDeviceDescriptor[];
  private readonly logs = new Map<string, readonly string[]>();
  private readonly logTails = new Map<string, Set<FakeAdbLogTail>>();
  private readonly sessions = new Map<string, FakeAdbDeviceSession>();

  public constructor(devices: readonly AdbDeviceDescriptor[]) {
    this.devices = devices;
  }

  public async listDevices(): Promise<AdbDeviceDescriptor[]> {
    return [...this.devices];
  }

  public setDeviceLogs(serial: string, lines: readonly string[]): void {
    this.logs.set(serial, [...lines]);
  }

  public appendDeviceLog(serial: string, line: string): void {
    this.logs.set(serial, [...(this.logs.get(serial) ?? []), line]);
    for (const tail of this.logTails.get(serial) ?? []) {
      tail.append(line);
    }
  }

  public activeLogTails(serial: string): readonly FakeAdbLogTail[] {
    return [...(this.logTails.get(serial) ?? [])];
  }

  public async readDeviceLogs(serial: string, lines: number): Promise<readonly string[]> {
    const device = this.devices.find((item) => item.serial === serial);
    if (!device || !isUsableDevice(device)) {
      throw new Error(`ADB device is not available: ${serial}`);
    }
    return [...(this.logs.get(serial) ?? [])].slice(-lines);
  }

  public async tailDeviceLogs(serial: string): Promise<FakeAdbLogTail> {
    const device = this.devices.find((item) => item.serial === serial);
    if (!device || !isUsableDevice(device)) {
      throw new Error(`ADB device is not available: ${serial}`);
    }
    const tail = new FakeAdbLogTail(() => {
      const tails = this.logTails.get(serial);
      tails?.delete(tail);
      if (tails?.size === 0) {
        this.logTails.delete(serial);
      }
    });
    const tails = this.logTails.get(serial) ?? new Set<FakeAdbLogTail>();
    tails.add(tail);
    this.logTails.set(serial, tails);
    return tail;
  }

  public async connect(serial: string): Promise<FakeAdbDeviceSession> {
    const device = this.devices.find((item) => item.serial === serial);
    if (!device || !isUsableDevice(device)) {
      throw new Error(`ADB device is not available: ${serial}`);
    }
    const existing = this.sessions.get(serial);
    if (existing) {
      return existing;
    }
    const session = new FakeAdbDeviceSession(serial);
    this.sessions.set(serial, session);
    return session;
  }
}

export class FakeAdbLogTail implements AdbLogTail {
  public readonly lines: AsyncIterable<string> = this.createLines();
  private closed = false;
  private readonly queue: string[] = [];
  private readonly waiters: Array<() => void> = [];

  public constructor(private readonly onClose: () => void) {}

  public append(line: string): void {
    if (this.closed) {
      return;
    }
    this.queue.push(line);
    this.wake();
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onClose();
    this.wake();
  }

  private async *createLines(): AsyncIterable<string> {
    while (!this.closed || this.queue.length > 0) {
      if (this.queue.length === 0) {
        // oxlint-disable-next-line no-await-in-loop -- fake tail waits for the next queued log line.
        await new Promise<void>((resolve) => {
          this.waiters.push(resolve);
        });
        continue;
      }
      const line = this.queue.shift();
      if (line !== undefined) {
        yield line;
      }
    }
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter();
    }
  }
}

export class FakeAdbDeviceSession implements AdbDeviceSession {
  public closed = false;
  public readonly commands: string[][] = [];
  public readonly pushes: Array<{ readonly localPath: string; readonly remotePath: string }> = [];
  public readonly sockets: FakeAdbSocket[] = [];

  public constructor(public readonly serial: string) {}

  public async push(localPath: string, remotePath: string): Promise<void> {
    this.pushes.push({ localPath, remotePath });
  }

  public async shell(command: readonly string[]): Promise<AdbShellProcess> {
    this.commands.push([...command]);
    return {
      command,
      exit: Promise.resolve(0),
      stderr: emptyByteStream(),
      stdout: singleChunkStream("droid-webscr:ready:droid-webscr\n"),
    };
  }

  public async openSocket(_name: string): Promise<AdbSocket> {
    const socket = new FakeAdbSocket();
    this.sockets.push(socket);
    return socket;
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}

async function* emptyByteStream(): AsyncIterable<Uint8Array> {}

async function* singleChunkStream(value: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(value);
}

export class FakeAdbSocket implements AdbSocket {
  public closed = false;
  public readonly writes: Uint8Array[] = [];
  public readonly chunks = Readable.from([]);
  public async write(chunk: Uint8Array): Promise<void> {
    this.writes.push(chunk);
  }
  public async close(): Promise<void> {
    this.closed = true;
  }
}
