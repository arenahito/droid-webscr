import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SystemAdbProvider } from "./system-adb-provider.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

type AdbChildProcess = EventEmitter & {
  readonly stderr: Readable;
  readonly stdout: Readable;
  kill(): boolean;
};

describe("SystemAdbProvider process handling", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("drains stderr while waiting for stdout to finish", async () => {
    const stdout = new Readable({ read() {} });
    let child: AdbChildProcess;
    let started = false;
    const stderr = new Readable({
      read() {
        if (started) {
          return;
        }
        started = true;
        this.push(Buffer.alloc(1024 * 1024, "x"));
        this.push(null);
        stdout.push("List of devices attached\n");
        stdout.push(null);
        setImmediate(() => child.emit("close", 0));
      },
    });
    spawnMock.mockImplementation(() => {
      child = createChild(stdout, stderr);
      return child;
    });
    const provider = new SystemAdbProvider("adb");

    await expect(provider.listDevices()).resolves.toEqual([]);
  }, 1_000);

  it("decodes multibyte stdout characters split across chunks", async () => {
    const chunks = splitInsideCharacter(
      "List of devices attached\nserial-1 device model:端末\n",
      "端",
    );
    spawnMock.mockImplementation(() => createCompletedChild(chunks));
    const provider = new SystemAdbProvider("adb");

    await expect(provider.listDevices()).resolves.toMatchObject([{ model: "端末" }]);
  });

  it("decodes multibyte log lines split across chunks", async () => {
    const logLine = "09-11 22:00:01.000  123  456 I Demo: 接続完了";
    const responses: readonly (readonly Buffer[])[] = [
      [Buffer.from("100\n")],
      [Buffer.from("09-11 22:00:01.000\n")],
      splitInsideCharacter(`${logLine}\n`, "接"),
    ];
    let callIndex = 0;
    spawnMock.mockImplementation(() => {
      const chunks = responses[callIndex];
      callIndex += 1;
      if (!chunks) {
        throw new Error("Unexpected ADB process invocation.");
      }
      return createCompletedChild(chunks);
    });
    const provider = new SystemAdbProvider("adb");

    const tail = await provider.tailDeviceLogs("serial-1");

    await expect(readAll(tail.lines)).resolves.toEqual([logLine]);
    await tail.close();
  });
});

function createCompletedChild(stdoutChunks: readonly Buffer[]): AdbChildProcess {
  const child = createChild(Readable.from(stdoutChunks), Readable.from([]));
  setImmediate(() => child.emit("close", 0));
  return child;
}

function createChild(stdout: Readable, stderr: Readable): AdbChildProcess {
  return Object.assign(new EventEmitter(), {
    kill: () => true,
    stderr,
    stdout,
  }) as AdbChildProcess;
}

function splitInsideCharacter(value: string, character: string): readonly Buffer[] {
  const bytes = Buffer.from(value);
  const characterStart = bytes.indexOf(Buffer.from(character));
  if (characterStart < 0) {
    throw new Error(`Character not found: ${character}`);
  }
  const splitAt = characterStart + 1;
  return [bytes.subarray(0, splitAt), bytes.subarray(splitAt)];
}

async function readAll(lines: AsyncIterable<string>): Promise<readonly string[]> {
  const values: string[] = [];
  for await (const line of lines) {
    values.push(line);
  }
  return values;
}
