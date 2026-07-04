import { EventEmitter } from "node:events";
import {
  createFrameHeader,
  createScrollControlFrame,
  encodeFrame,
  MessageType,
  StreamId,
} from "@droid-webscr/protocol";
import { describe, expect, it } from "vitest";
import { bridgeBrowserToDevice } from "./bridge-session.js";

class TestSocket extends EventEmitter {
  public sent: Uint8Array[] = [];
  public send(data: Uint8Array) {
    this.sent.push(data);
  }
}

describe("bridge session", () => {
  it("ignores text messages and closes idempotently on errors", async () => {
    const socket = new TestSocket();
    let stopCount = 0;
    const written: Uint8Array[] = [];
    const bridge = bridgeBrowserToDevice(socket, {
      frames: (async function* () {
        yield new Uint8Array([7, 8]);
      })(),
      serial: "emulator-5554",
      stop: async () => {
        stopCount += 1;
      },
      write: async (frame) => {
        written.push(frame);
      },
    });

    socket.emit("message", "json is not protocol traffic");
    socket.emit("message", new ArrayBuffer(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(written).toHaveLength(1);
    expect(socket.sent.map((item) => [...item])).toEqual([[7, 8]]);
    socket.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.emit("error", new Error("boom"));
    await bridge.close();
    await bridge.close();

    expect(stopCount).toBe(1);
  });

  it("injects scroll frames through adb shell instead of forwarding them", async () => {
    const socket = new TestSocket();
    const written: Uint8Array[] = [];
    const shellCommands: string[][] = [];
    bridgeBrowserToDevice(socket, {
      frames: (async function* () {})(),
      serial: "emulator-5554",
      shell: async (command) => {
        shellCommands.push([...command]);
        return 0;
      },
      stop: async () => {},
      write: async (frame) => {
        written.push(frame);
      },
    });

    socket.emit(
      "message",
      createScrollControlFrame({
        displayId: 0,
        horizontal: 1.5,
        sequence: 2n,
        vertical: -2.25,
        x: 433,
        y: 960,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(written).toEqual([]);
    expect(shellCommands).toEqual([
      [
        "input",
        "mouse",
        "-d",
        "0",
        "scroll",
        "433",
        "960",
        "--axis",
        "HSCROLL,1.5",
        "--axis",
        "VSCROLL,-2.25",
      ],
    ]);
  });

  it("forwards non scroll and failed scroll frames to the device socket", async () => {
    const socket = new TestSocket();
    const written: Uint8Array[] = [];
    bridgeBrowserToDevice(socket, {
      frames: (async function* () {})(),
      serial: "emulator-5554",
      shell: async () => 1,
      stop: async () => {},
      write: async (frame) => {
        written.push(frame);
      },
    });
    const scroll = createScrollControlFrame({
      horizontal: 0,
      sequence: 1n,
      vertical: -1,
      x: 1,
      y: 2,
    });
    const key = encodeFrame({
      header: createFrameHeader({
        payloadLength: 0,
        streamId: StreamId.Control,
        type: MessageType.ControlKey,
      }),
      payload: new Uint8Array(),
    });

    socket.emit("message", scroll);
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.emit("message", key);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(written).toEqual([scroll, key]);
  });
});
