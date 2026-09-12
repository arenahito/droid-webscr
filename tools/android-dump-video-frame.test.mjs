import assert from "node:assert/strict";
import { test } from "node:test";
import { runAndroidVideoFrameDump } from "./android-dump-video-frame-lib.mjs";

test("allocates a forward and removes only the allocated port", async () => {
  const calls = [];
  const serverProcess = { kill: () => calls.push({ kind: "server.kill" }) };
  const runner = createRunner(calls, serverProcess);
  const frames = [
    createFrame(0x0002, new Uint8Array()),
    createFrame(0x0201, new Uint8Array([...new Uint8Array(16), 1, 2])),
    createFrame(0x0202, new Uint8Array([3, 4])),
  ];
  const socket = {
    close: async () => calls.push({ kind: "socket.close" }),
    readFrame: async () => frames.shift(),
    writeFrame: async (frame) => calls.push({ frame, kind: "socket.writeFrame" }),
  };
  let written;

  const result = await runAndroidVideoFrameDump({
    adbPath: "adb",
    connectProtocolSocket: async (port) => {
      calls.push({ kind: "connect", port });
      return socket;
    },
    runner,
    serial: "emulator-5554",
    socketName: "droid-webscr",
    writeOutput: async (bytes) => {
      written = bytes;
      return "first-frame.h264";
    },
  });

  assert.equal(result.forwardedPort, 41002);
  assert.equal(result.h264, "first-frame.h264");
  assert.deepEqual([...written], [1, 2, 3, 4]);
  assert.equal(
    calls.some((call) => call.args?.includes("--remove-all")),
    false,
  );
  assert.deepEqual(
    calls.filter((call) => call.args?.includes("forward")).map((call) => call.args.slice(-3)),
    [
      ["forward", "tcp:0", "localabstract:droid-webscr"],
      ["forward", "--remove", "tcp:41002"],
    ],
  );
  assert.equal(calls.filter((call) => call.kind === "server.kill").length, 1);
  assert.equal(calls.filter((call) => call.kind === "socket.close").length, 1);
});

test("removes its forward and stops the server after a connection failure", async () => {
  const calls = [];
  const serverProcess = { kill: () => calls.push({ kind: "server.kill" }) };
  const runner = createRunner(calls, serverProcess);

  await assert.rejects(
    runAndroidVideoFrameDump({
      adbPath: "adb",
      connectProtocolSocket: async () => {
        throw new Error("connection failed");
      },
      runner,
      serial: "emulator-5554",
      socketName: "droid-webscr",
      writeOutput: async () => {
        throw new Error("write should not run");
      },
    }),
    /connection failed/,
  );

  assert.deepEqual(
    calls.filter((call) => call.args?.includes("forward")).map((call) => call.args.slice(-3)),
    [
      ["forward", "tcp:0", "localabstract:droid-webscr"],
      ["forward", "--remove", "tcp:41002"],
    ],
  );
  assert.equal(calls.filter((call) => call.kind === "server.kill").length, 1);
});

test("surfaces an early background server failure before the readiness timeout", async () => {
  const calls = [];
  const serverProcess = { kill: () => calls.push({ kind: "server.kill" }) };
  const runner = createRunner(calls, serverProcess, {
    serverExit: Promise.resolve({
      status: 1,
      stderr: "app_process failed",
      stdout: "",
    }),
    serverOutput: { stderr: "", stdout: "" },
  });

  const startedAt = Date.now();
  await assert.rejects(
    runAndroidVideoFrameDump({
      adbPath: "adb",
      connectProtocolSocket: async () => {
        throw new Error("connect should not run");
      },
      readinessTimeoutMs: 5_000,
      runner,
      serial: "emulator-5554",
      socketName: "droid-webscr",
      writeOutput: async () => "unused.h264",
    }),
    /app_process failed/,
  );
  assert.ok(Date.now() - startedAt < 1_000, "early exit should not wait for the readiness timeout");

  assert.equal(
    calls.some((call) => call.args?.includes("forward")),
    false,
  );
  assert.equal(calls.filter((call) => call.kind === "server.kill").length, 1);
});

test("surfaces a background spawn error without allocating a forward", async () => {
  const calls = [];
  const runner = {
    run: async (command) => {
      calls.push(command);
      if (command.background) {
        throw new Error("spawn adb ENOENT");
      }
      return { status: 0, stderr: "", stdout: "" };
    },
  };

  await assert.rejects(
    runAndroidVideoFrameDump({
      adbPath: "adb",
      runner,
      serial: "emulator-5554",
      socketName: "droid-webscr",
    }),
    /spawn adb ENOENT/,
  );
  assert.equal(
    calls.some((call) => call.args?.includes("forward")),
    false,
  );
});

test("reports failure to remove its allocated forward", async () => {
  const calls = [];
  const serverProcess = { kill: () => calls.push({ kind: "server.kill" }) };
  const runner = createRunner(calls, serverProcess, { removeStatus: 1 });
  const frames = [
    createFrame(0x0002, new Uint8Array()),
    createFrame(0x0201, new Uint8Array([...new Uint8Array(16), 1, 2])),
    createFrame(0x0202, new Uint8Array([3, 4])),
  ];

  await assert.rejects(
    runAndroidVideoFrameDump({
      adbPath: "adb",
      connectProtocolSocket: async () => ({
        close: async () => {},
        readFrame: async () => frames.shift(),
        writeFrame: async () => {},
      }),
      runner,
      serial: "emulator-5554",
      socketName: "droid-webscr",
      writeOutput: async () => "first-frame.h264",
    }),
    /cannot remove forward/,
  );

  assert.equal(
    calls.some((call) => call.args?.includes("--remove-all")),
    false,
  );
  assert.deepEqual(calls.find((call) => call.args?.includes("--remove"))?.args.slice(-3), [
    "forward",
    "--remove",
    "tcp:41002",
  ]);
});

function createRunner(calls, serverProcess, options = {}) {
  const pendingExit = new Promise(() => {});
  return {
    run: async (command) => {
      calls.push(command);
      if (command.background) {
        return {
          exit: options.serverExit ?? pendingExit,
          output: () =>
            options.serverOutput ?? {
              stderr: "",
              stdout: "droid-webscr:ready:droid-webscr\n",
            },
          process: serverProcess,
          status: 0,
          stderr: "",
          stdout: "",
        };
      }
      if (command.args.includes("tcp:0")) {
        return { status: 0, stderr: "", stdout: "tcp:41002\n" };
      }
      if (command.args.includes("--remove") && options.removeStatus) {
        return {
          status: options.removeStatus,
          stderr: "cannot remove forward",
          stdout: "",
        };
      }
      return { status: 0, stderr: "", stdout: "" };
    },
  };
}

function createFrame(type, payload) {
  const frame = new Uint8Array(40 + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint16(8, type, false);
  view.setUint32(16, payload.byteLength, false);
  frame.set(payload, 40);
  return frame;
}
