import { AdbProvider } from "@droid-webscr/adb";
import { defaultDeviceServerArtifact, DeviceServerArtifact } from "./artifact.js";
import { deployDeviceServer } from "./deploy.js";
import { StartedDeviceSession } from "../session/device-session.js";
import { SessionVideoSettings } from "../session/session-manager.js";

export interface DeviceServer {
  start(serial: string, video: SessionVideoSettings): Promise<StartedDeviceSession>;
}

export class AdbDeviceServer implements DeviceServer {
  public constructor(
    private readonly adbProvider: AdbProvider,
    private readonly artifact: DeviceServerArtifact = defaultDeviceServerArtifact,
  ) {}

  public async start(serial: string, video: SessionVideoSettings): Promise<StartedDeviceSession> {
    const session = await this.adbProvider.connect(serial);
    await deployDeviceServer(session, this.artifact);
    await session
      .shell([
        `CLASSPATH=${this.artifact.remotePath}`,
        "app_process",
        "/",
        "dev.droidwebscr.server.MainKt",
        "--verify-once",
        "droid-webscr",
        "--bitrate-mbps",
        String(video.bitrateMbps),
        "--max-fps",
        String(video.fps),
      ])
      .then((process) => waitForDeviceServerReady(process.stdout, "droid-webscr"));
    const socket = await session.openSocket("localabstract:droid-webscr");
    return {
      frames: socket.chunks,
      serial,
      stop: async () => {
        await Promise.allSettled([socket.close(), session.close()]);
      },
      write: async (frame) => {
        await socket.write(frame);
      },
    };
  }
}

export async function waitForDeviceServerReady(
  stdout: AsyncIterable<Uint8Array>,
  socketName: string,
  timeoutMs = 5_000,
): Promise<void> {
  const expected = `droid-webscr:ready:${socketName}`;
  if (isReadableEventSource(stdout)) {
    return waitForReadableData(stdout, expected, timeoutMs);
  }
  await Promise.race([
    (async () => {
      const output = await collectTextUntil(stdout, expected);
      if (!output.includes(expected)) {
        throw new Error("Android device server exited before reporting ready.");
      }
    })(),
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error("Timed out waiting for Android device server readiness."));
      }, timeoutMs);
    }),
  ]);
}

function waitForReadableData(
  stdout: ReadableEventSource,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  const decoder = new TextDecoder();
  let output = "";
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      stdout.off("data", onData);
      stdout.off("end", onEnd);
      stdout.off("error", onError);
    };
    const onData = (chunk: Uint8Array) => {
      output += decoder.decode(chunk, { stream: true });
      if (output.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("Android device server exited before reporting ready."));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Android device server readiness."));
    }, timeoutMs);
    stdout.on("data", onData);
    stdout.on("end", onEnd);
    stdout.on("error", onError);
  });
}

interface ReadableEventSource extends AsyncIterable<Uint8Array> {
  off(event: "data", listener: (chunk: Uint8Array) => void): void;
  off(event: "end", listener: () => void): void;
  off(event: "error", listener: (error: Error) => void): void;
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

function isReadableEventSource(value: AsyncIterable<Uint8Array>): value is ReadableEventSource {
  const candidate = value as Partial<ReadableEventSource>;
  return typeof candidate.on === "function" && typeof candidate.off === "function";
}

async function collectTextUntil(
  chunks: AsyncIterable<Uint8Array>,
  expected: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  for await (const chunk of chunks) {
    output += decoder.decode(chunk, { stream: true });
    if (output.includes(expected)) {
      return output;
    }
  }
  return output + decoder.decode();
}
