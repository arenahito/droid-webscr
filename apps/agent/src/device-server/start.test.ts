import { describe, expect, it } from "vitest";
import { AdbAuthorizationState, AdbTransportKind, FakeAdbProvider } from "@droid-webscr/adb";
import { Readable } from "node:stream";
import { AdbDeviceServer, waitForDeviceServerReady } from "./start.js";
import { defaultDeviceServerArtifact } from "./artifact.js";

describe("ADB device server boundary", () => {
  it("starts and stops through the selected ADB session", async () => {
    const provider = new FakeAdbProvider([
      {
        authorizationState: AdbAuthorizationState.Authorized,
        serial: "emulator-5554",
        transportKind: AdbTransportKind.Emulator,
      },
    ]);
    const server = new AdbDeviceServer(provider);

    const session = await server.start("emulator-5554", { bitrateMbps: 4, fps: 30 });
    const adbSession = await provider.connect("emulator-5554");

    expect(session.serial).toBe("emulator-5554");
    expect(adbSession.pushes).toEqual([
      {
        localPath: defaultDeviceServerArtifact.localPath,
        remotePath: defaultDeviceServerArtifact.remotePath,
      },
    ]);
    expect(adbSession.commands).toEqual([
      [
        "CLASSPATH=/data/local/tmp/droid-webscr-server.jar",
        "app_process",
        "/",
        "dev.droidwebscr.server.MainKt",
        "--verify-once",
        "droid-webscr",
        "--bitrate-mbps",
        "4",
        "--max-fps",
        "30",
      ],
    ]);
    await session.write(new Uint8Array([1]));
    expect(adbSession.sockets[0]?.writes).toEqual([new Uint8Array([1])]);
    const closeOrder: string[] = [];
    const socket = adbSession.sockets[0];
    if (!socket) {
      throw new Error("Expected a forwarded socket.");
    }
    socket.close = async () => {
      closeOrder.push("socket");
      socket.closed = true;
    };
    adbSession.close = async () => {
      closeOrder.push("session");
      adbSession.closed = true;
    };
    await session.stop();
    expect(adbSession.sockets[0]?.closed).toBe(true);
    expect(adbSession.closed).toBe(true);
    expect(closeOrder).toEqual(["socket", "session"]);
  });

  it("keeps session cleanup idempotent when the forwarded socket is already gone", async () => {
    const provider = new FakeAdbProvider([
      {
        authorizationState: AdbAuthorizationState.Authorized,
        serial: "emulator-5554",
        transportKind: AdbTransportKind.Emulator,
      },
    ]);
    const server = new AdbDeviceServer(provider);
    const session = await server.start("emulator-5554", { bitrateMbps: 4, fps: 30 });
    const adbSession = await provider.connect("emulator-5554");
    const socket = adbSession.sockets[0];
    if (!socket) {
      throw new Error("Expected a forwarded socket.");
    }
    socket.close = async () => {
      throw new Error("adb.exe: error: listener 'tcp:57966' not found");
    };

    await expect(session.stop()).resolves.toBeUndefined();

    expect(adbSession.closed).toBe(true);
  });

  it("closes partially started ADB resources when startup is aborted", async () => {
    const provider = new FakeAdbProvider([
      {
        authorizationState: AdbAuthorizationState.Authorized,
        serial: "emulator-5554",
        transportKind: AdbTransportKind.Emulator,
      },
    ]);
    const server = new AdbDeviceServer(provider);
    const abort = new AbortController();

    abort.abort();
    await expect(
      server.start("emulator-5554", { bitrateMbps: 4, fps: 30 }, abort.signal),
    ).rejects.toThrow("Device session startup aborted.");
  });

  it("closes a forwarded socket that resolves after startup is aborted", async () => {
    let resolveSocket:
      | ((socket: {
          close(): Promise<void>;
          chunks: AsyncIterable<Uint8Array>;
          write(): Promise<void>;
        }) => void)
      | undefined;
    let socketClosed = false;
    let sessionClosed = false;
    const abort = new AbortController();
    const server = new AdbDeviceServer({
      connect: async (serial) => ({
        close: async () => {
          sessionClosed = true;
        },
        openSocket: async () =>
          await new Promise((resolve) => {
            resolveSocket = resolve;
          }),
        push: async () => {},
        serial,
        shell: async (command) => ({
          command,
          exit: Promise.resolve(0),
          stderr: emptyByteStream(),
          stdout: singleChunkStream("droid-webscr:ready:droid-webscr\n"),
        }),
      }),
      listDevices: async () => [],
      readDeviceLogs: async () => [],
      tailDeviceLogs: async () => {
        throw new Error("unused");
      },
    });

    const started = server.start("emulator-5554", { bitrateMbps: 4, fps: 30 }, abort.signal);
    await waitForCondition(() => resolveSocket !== undefined);
    abort.abort();
    await expect(started).rejects.toThrow("Device session startup aborted.");
    resolveSocket?.({
      chunks: emptyByteStream(),
      close: async () => {
        socketClosed = true;
      },
      write: async () => {},
    });
    await waitForCondition(() => socketClosed);

    expect(sessionClosed).toBe(true);
  });

  it("ignores a forwarded socket failure that arrives after startup is aborted", async () => {
    let rejectSocket: ((error: Error) => void) | undefined;
    let sessionClosed = false;
    const abort = new AbortController();
    const server = new AdbDeviceServer({
      connect: async (serial) => ({
        close: async () => {
          sessionClosed = true;
        },
        openSocket: async () =>
          await new Promise<{
            close(): Promise<void>;
            chunks: AsyncIterable<Uint8Array>;
            write(): Promise<void>;
          }>((_resolve, reject) => {
            rejectSocket = reject;
          }),
        push: async () => {},
        serial,
        shell: async (command) => ({
          command,
          exit: Promise.resolve(0),
          stderr: emptyByteStream(),
          stdout: singleChunkStream("droid-webscr:ready:droid-webscr\n"),
        }),
      }),
      listDevices: async () => [],
      readDeviceLogs: async () => [],
      tailDeviceLogs: async () => {
        throw new Error("unused");
      },
    });

    const started = server.start("emulator-5554", { bitrateMbps: 4, fps: 30 }, abort.signal);
    await waitForCondition(() => rejectSocket !== undefined);
    abort.abort();
    await expect(started).rejects.toThrow("Device session startup aborted.");
    rejectSocket?.(new Error("socket listener disappeared"));

    expect(sessionClosed).toBe(true);
  });

  it("waits for the Android server readiness signal before opening the socket", async () => {
    await expect(
      waitForDeviceServerReady(
        Readable.from([new TextEncoder().encode("noise\ndroid-webscr:ready:droid-webscr\n")]),
        "droid-webscr",
      ),
    ).resolves.toBeUndefined();
  });

  it("waits for readiness from plain async iterables", async () => {
    await expect(
      waitForDeviceServerReady(
        singleChunkStream("noise\ndroid-webscr:ready:droid-webscr\n"),
        "droid-webscr",
      ),
    ).resolves.toBeUndefined();
  });

  it("fails when the Android server exits before readiness", async () => {
    await expect(waitForDeviceServerReady(Readable.from([]), "droid-webscr", 10)).rejects.toThrow(
      "Android device server exited before reporting ready.",
    );
  });

  it("fails when a plain startup stream ends before readiness", async () => {
    await expect(
      waitForDeviceServerReady(
        singleChunkStream("booting without readiness\n"),
        "droid-webscr",
        10,
      ),
    ).rejects.toThrow("Android device server exited before reporting ready.");
  });

  it("propagates readable stream errors while waiting for readiness", async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error("adb shell stream failed"));
      },
    });

    await expect(waitForDeviceServerReady(source, "droid-webscr", 10)).rejects.toThrow(
      "adb shell stream failed",
    );
  });

  it("times out while waiting for readiness from a still-open readable stream", async () => {
    const source = new Readable({
      read() {
        return;
      },
    });

    await expect(waitForDeviceServerReady(source, "droid-webscr", 1)).rejects.toThrow(
      "Timed out waiting for Android device server readiness.",
    );
    source.destroy();
  });

  it("times out while waiting for readiness from a still-open plain async iterable", async () => {
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { done: true, value: undefined };
        },
      }),
    };

    await expect(waitForDeviceServerReady(source, "droid-webscr", 1)).rejects.toThrow(
      "Timed out waiting for Android device server readiness.",
    );
  });
});

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- polling waits for async startup steps.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for condition");
}

async function* emptyByteStream(): AsyncIterable<Uint8Array> {}

async function* singleChunkStream(value: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(value);
}
