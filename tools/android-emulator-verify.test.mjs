import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createHelloAckFrame,
  createLogFrame,
  createVideoConfigFrame,
  createVideoFrame,
  runAndroidEmulatorVerification,
} from "./android-emulator-verify-lib.mjs";

test("fails clearly when adb reports no online devices", async () => {
  await assert.rejects(
    runAndroidEmulatorVerification({
      adbPath: "adb",
      runner: fakeRunner([
        {
          args: ["devices", "-l"],
          stdout: "List of devices attached\nemulator-5554\toffline transport_id:1\n",
        },
      ]),
    }),
    /No online Android emulator was reported by adb devices -l\./,
  );
});

test("does not treat a non-emulator adb device as emulator-backed verification", async () => {
  await assert.rejects(
    runAndroidEmulatorVerification({
      adbPath: "adb",
      runner: fakeRunner([
        {
          args: ["devices", "-l"],
          stdout:
            "List of devices attached\nR5CT1234567\tdevice product:pixel model:Pixel_8 device:shiba transport_id:2\n",
        },
      ]),
    }),
    /No online Android emulator was reported by adb devices -l\./,
  );
});

test("builds, deploys, starts, verifies HELLO, and cleans up the Android server", async () => {
  const calls = [];
  const runner = fakeRunner(
    [
      {
        args: ["devices", "-l"],
        stdout:
          "List of devices attached\nemulator-5554\tdevice product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1\n",
      },
      { args: serialArgs("shell", "rm", "-f", "/data/local/tmp/droid-webscr-server.jar") },
      {
        args: serialArgs(
          "push",
          "android/server/build/droid-webscr-server-android.jar",
          "/data/local/tmp/droid-webscr-server.jar",
        ),
      },
      {
        args: serialArgs(
          "shell",
          "CLASSPATH=/data/local/tmp/droid-webscr-server.jar",
          "app_process",
          "/",
          "dev.droidwebscr.server.MainKt",
          "--verify-once",
          "droid-webscr",
        ),
        pid: 321,
      },
      { args: serialArgs("forward", "tcp:0", "localabstract:droid-webscr"), stdout: "tcp:41001\n" },
      { args: serialArgs("forward", "--remove", "tcp:41001") },
      { args: serialArgs("shell", "rm", "-f", "/data/local/tmp/droid-webscr-server.jar") },
    ],
    calls,
  );

  const frames = [
    createHelloAckFrame(),
    createVideoConfigFrame(),
    createVideoFrame(),
    createVideoFrame(),
    createLogFrame("control:pointer:Accepted"),
    createVideoFrame(),
    createLogFrame("control:pointer:Accepted"),
    createLogFrame("control:pointer:Accepted"),
    createLogFrame("control:pointer:Accepted"),
    createLogFrame("control:pointer:Accepted"),
    createLogFrame("control:pointer:Accepted"),
    createLogFrame("control:pointer:Accepted"),
    createLogFrame("control:pointer:Accepted"),
    createLogFrame("control:pointer:Accepted"),
    createLogFrame("control:key:Accepted"),
    createLogFrame("control:key:Accepted"),
    createLogFrame("control:text:Accepted"),
    createLogFrame("control:home:Accepted"),
    createLogFrame("clipboard:set:Rejected(Clipboard sync is disabled by policy.)"),
    createLogFrame("video:reconfigure:Accepted"),
  ];
  const sockets = [
    {
      close: async () => calls.push({ kind: "socket.close" }),
      readFrame: async () => frames.shift(),
      writeFrame: async (frame) => calls.push({ frame, kind: "socket.writeFrame" }),
    },
  ];

  const result = await runAndroidEmulatorVerification({
    adbPath: "adb",
    artifactPath: "android/server/build/droid-webscr-server-android.jar",
    buildServerArtifact: async () => calls.push({ kind: "build" }),
    connectTcpSocket: async (port) => {
      calls.push({ kind: "connect", port });
      return sockets.shift();
    },
    runner,
    socketName: "droid-webscr",
  });

  assert.equal(result.serial, "emulator-5554");
  assert.equal(result.forwardedPort, 41001);
  assert.deepEqual(
    calls.map((call) => (call.args ? call.args.join(" ") : call.kind)),
    [
      "devices -l",
      "build",
      "-s emulator-5554 shell rm -f /data/local/tmp/droid-webscr-server.jar",
      "-s emulator-5554 push android/server/build/droid-webscr-server-android.jar /data/local/tmp/droid-webscr-server.jar",
      "-s emulator-5554 shell CLASSPATH=/data/local/tmp/droid-webscr-server.jar app_process / dev.droidwebscr.server.MainKt --verify-once droid-webscr",
      "-s emulator-5554 forward tcp:0 localabstract:droid-webscr",
      "connect",
      "socket.writeFrame",
      "socket.writeFrame",
      "socket.writeFrame",
      "socket.writeFrame",
      "socket.writeFrame",
      "socket.writeFrame",
      "socket.writeFrame",
      "socket.writeFrame",
      "socket.writeFrame",
      "socket.writeFrame",
      "socket.writeFrame",
      "socket.writeFrame",
      "socket.writeFrame",
      "socket.writeFrame",
      "socket.writeFrame",
      "socket.writeFrame",
      "socket.close",
      "-s emulator-5554 forward --remove tcp:41001",
      "-s emulator-5554 shell rm -f /data/local/tmp/droid-webscr-server.jar",
    ],
  );
  assert.deepEqual(result.controlLogs, [
    "control:pointer:Accepted",
    "control:pointer:Accepted",
    "control:pointer:Accepted",
    "control:pointer:Accepted",
    "control:pointer:Accepted",
    "control:pointer:Accepted",
    "control:pointer:Accepted",
    "control:pointer:Accepted",
    "control:pointer:Accepted",
    "control:key:Accepted",
    "control:key:Accepted",
    "control:text:Accepted",
    "control:home:Accepted",
    "clipboard:set:Rejected(Clipboard sync is disabled by policy.)",
    "video:reconfigure:Accepted",
  ]);
  assert.deepEqual(
    calls
      .filter((call) => call.kind === "socket.writeFrame")
      .map((call) => call.frame)
      .filter((frame) => frameType(frame) === 0x0301)
      .map(pointerId),
    [0, 0, 0, 0, 1, 0, 1, 1, 0],
  );
  assert.deepEqual(
    calls
      .filter((call) => call.kind === "socket.writeFrame")
      .map((call) => call.frame)
      .map(frameSequence),
    [1n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n, 13n, 14n, 15n, 16n, 17n],
  );
});

function fakeRunner(script, calls = []) {
  return {
    run: async (command) => {
      calls.push({ args: command.args });
      const step = script.shift();
      assert.ok(step, `unexpected command: ${command.args.join(" ")}`);
      assert.deepEqual(command.args, step.args);
      return {
        pid: step.pid,
        status: step.status ?? 0,
        stderr: step.stderr ?? "",
        stdout: step.stdout ?? "",
      };
    },
  };
}

function serialArgs(...args) {
  return ["-s", "emulator-5554", ...args];
}

function frameType(frame) {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(8, false);
}

function pointerId(frame) {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(42, false);
}

function frameSequence(frame) {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getBigUint64(28, false);
}
