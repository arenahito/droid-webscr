import { EventEmitter } from "node:events";
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
    socket.emit("error", new Error("boom"));
    await bridge.close();
    await bridge.close();

    expect(stopCount).toBe(1);
  });
});
