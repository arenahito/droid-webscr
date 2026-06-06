import { spawn } from "node:child_process";
import { createConnection, Server, Socket } from "node:net";
import { Readable } from "node:stream";
import {
  AdbAuthorizationState,
  AdbDeviceDescriptor,
  AdbDeviceSession,
  AdbProvider,
  AdbShellProcess,
  AdbSocket,
  AdbTransportKind,
} from "./provider.js";

export class SystemAdbProvider implements AdbProvider {
  public constructor(private readonly adbPath = "adb") {}

  /* v8 ignore next 4 -- external adb process boundary; deterministic parsing is unit-tested */
  public async listDevices(): Promise<AdbDeviceDescriptor[]> {
    const output = await runAndCollect(this.adbPath, ["devices", "-l"]);
    return SystemAdbProvider.parseDevices(output);
  }

  /* v8 ignore next 3 -- external adb process boundary; deterministic parsing is unit-tested */
  public async connect(serial: string): Promise<AdbDeviceSession> {
    return new SystemAdbDeviceSession(this.adbPath, serial);
  }

  /* v8 ignore next 3 -- external adb process boundary */
  public async connectEndpoint(endpoint: string): Promise<void> {
    await runAndCollect(this.adbPath, ["connect", endpoint]);
  }

  /* v8 ignore next 3 -- external adb process boundary */
  public async disconnect(serial: string): Promise<void> {
    await runAndCollect(this.adbPath, ["disconnect", serial]);
  }

  public static parseDevices(output: string): AdbDeviceDescriptor[] {
    return output
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseDeviceLine);
  }
}

/* v8 ignore start -- external adb process boundary */
class SystemAdbDeviceSession implements AdbDeviceSession {
  public constructor(
    private readonly adbPath: string,
    public readonly serial: string,
  ) {}

  public async push(localPath: string, remotePath: string): Promise<void> {
    await runAndCollect(this.adbPath, ["-s", this.serial, "push", localPath, remotePath]);
  }

  public async shell(command: readonly string[]): Promise<AdbShellProcess> {
    const child = spawn(this.adbPath, ["-s", this.serial, "shell", ...command], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return {
      command,
      exit: new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code: number | null) => resolve(code ?? 1));
      }),
      stderr: child.stderr ?? Readable.from([]),
      stdout: child.stdout ?? Readable.from([]),
    };
  }

  public async openSocket(name: string): Promise<AdbSocket> {
    const localPort = await reserveTcpPort();
    const forward = buildLocalAbstractForward(localPort, name);
    await runAndCollect(this.adbPath, [
      "-s",
      this.serial,
      "forward",
      forward.local,
      forward.remote,
    ]);
    const socket = await connectLocalPort(localPort);
    return new ForwardedAdbSocket(this.adbPath, this.serial, forward.local, socket);
  }

  public async close(): Promise<void> {}
}
/* v8 ignore stop */

export interface LocalAbstractForward {
  readonly local: string;
  readonly remote: string;
}

export function buildLocalAbstractForward(localPort: number, name: string): LocalAbstractForward {
  return {
    local: `tcp:${localPort}`,
    remote: normalizeLocalAbstractName(name),
  };
}

function normalizeLocalAbstractName(name: string): string {
  const socketName = name.startsWith("localabstract:") ? name.slice("localabstract:".length) : name;
  if (!/^[A-Za-z0-9._-]+$/.test(socketName)) {
    throw new Error("Invalid localabstract socket name.");
  }
  return `localabstract:${socketName}`;
}

function parseDeviceLine(line: string): AdbDeviceDescriptor {
  const [serial = "", state = "", ...fields] = line.split(/\s+/);
  return {
    authorizationState: parseAuthorizationState(state),
    model: parseField(fields, "model"),
    serial,
    transportKind: inferTransportKind(serial, fields),
  };
}

function parseAuthorizationState(state: string): AdbAuthorizationState {
  if (state === "device") {
    return AdbAuthorizationState.Authorized;
  }
  if (state === "unauthorized") {
    return AdbAuthorizationState.Unauthorized;
  }
  return AdbAuthorizationState.Offline;
}

function inferTransportKind(serial: string, fields: readonly string[]): AdbTransportKind {
  if (serial.startsWith("emulator-")) {
    return AdbTransportKind.Emulator;
  }
  if (serial.includes(":")) {
    return AdbTransportKind.Network;
  }
  if (fields.some((field) => field.startsWith("usb:"))) {
    return AdbTransportKind.Usb;
  }
  return AdbTransportKind.Usb;
}

function parseField(fields: readonly string[], key: string): string | undefined {
  const prefix = `${key}:`;
  return fields.find((field) => field.startsWith(prefix))?.slice(prefix.length);
}

/* v8 ignore start -- external adb process boundary */
async function runAndCollect(command: string, args: readonly string[]): Promise<string> {
  const child = spawn(command, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = await collect(child.stdout ?? Readable.from([]));
  const stderr = await collect(child.stderr ?? Readable.from([]));
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode: number | null) => resolve(exitCode ?? 1));
  });
  if (code !== 0) {
    throw new Error(stderr || `${command} ${args.join(" ")} failed with exit code ${code}`);
  }
  return stdout;
}

async function collect(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(String(chunk));
  }
  return chunks.join("");
}

async function reserveTcpPort(): Promise<number> {
  const server = new Server();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve a local TCP port.");
  }
  return address.port;
}

async function connectLocalPort(port: number): Promise<Socket> {
  const socket = createConnection({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

class ForwardedAdbSocket implements AdbSocket {
  public readonly chunks: AsyncIterable<Uint8Array>;

  public constructor(
    private readonly adbPath: string,
    private readonly serial: string,
    private readonly localForward: string,
    private readonly socket: Socket,
  ) {
    this.chunks = socket;
  }

  public async write(chunk: Uint8Array): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.write(chunk, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  public async close(): Promise<void> {
    this.socket.destroy();
    await runAndCollect(this.adbPath, [
      "-s",
      this.serial,
      "forward",
      "--remove",
      this.localForward,
    ]);
  }
}
/* v8 ignore stop */
