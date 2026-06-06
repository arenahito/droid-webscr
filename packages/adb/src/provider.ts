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
}

export function isUsableDevice(device: AdbDeviceDescriptor): boolean {
  return device.authorizationState === AdbAuthorizationState.Authorized && device.serial.length > 0;
}

export class FakeAdbProvider implements AdbProvider {
  private readonly devices: readonly AdbDeviceDescriptor[];

  public constructor(devices: readonly AdbDeviceDescriptor[]) {
    this.devices = devices;
  }

  public async listDevices(): Promise<AdbDeviceDescriptor[]> {
    return [...this.devices];
  }

  public async connect(serial: string): Promise<FakeAdbDeviceSession> {
    const device = this.devices.find((item) => item.serial === serial);
    if (!device || !isUsableDevice(device)) {
      throw new Error(`ADB device is not available: ${serial}`);
    }
    return new FakeAdbDeviceSession(serial);
  }
}

export class FakeAdbDeviceSession implements AdbDeviceSession {
  public closed = false;
  public readonly pushes: Array<{ readonly localPath: string; readonly remotePath: string }> = [];

  public constructor(public readonly serial: string) {}

  public async push(localPath: string, remotePath: string): Promise<void> {
    this.pushes.push({ localPath, remotePath });
  }

  public async shell(command: readonly string[]): Promise<AdbShellProcess> {
    return {
      command,
      exit: Promise.resolve(0),
      stderr: Readable.from([]),
      stdout: Readable.from([]),
    };
  }

  public async openSocket(_name: string): Promise<AdbSocket> {
    return new FakeAdbSocket();
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeAdbSocket implements AdbSocket {
  public readonly chunks = Readable.from([]);
  public async write(_chunk: Uint8Array): Promise<void> {}
  public async close(): Promise<void> {}
}
