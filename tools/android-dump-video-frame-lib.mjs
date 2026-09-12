import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputDir = new URL("../.tasks/evidence/android-video-dump/", import.meta.url);
const localArtifactPath = fileURLToPath(
  new URL("../android/server/build/droid-webscr-server-android.jar", import.meta.url),
);
const remoteArtifactPath = "/data/local/tmp/droid-webscr-server.jar";
const headerLength = 40;
const messageTypeSessionHello = 0x0001;
const messageTypeSessionHelloAck = 0x0002;
const messageTypeVideoConfig = 0x0201;
const messageTypeVideoFrame = 0x0202;
const streamIdSession = 1;

export async function runAndroidVideoFrameDump(options = {}) {
  const adbPath = options.adbPath ?? "adb";
  const connectSocket = options.connectProtocolSocket ?? connectProtocolSocket;
  const runner = options.runner ?? createProcessRunner();
  const serial = options.serial ?? "emulator-5554";
  const socketName = options.socketName ?? "droid-webscr";
  const writeOutput = options.writeOutput ?? writeDefaultOutput;
  let forwardedPort;
  let operationError;
  let operationFailed = false;
  let result;
  let server;
  let socket;

  try {
    await adb(runner, adbPath, ["-s", serial, "shell", "pkill", "-f", remoteArtifactPath], {
      allowFailure: true,
    });
    await adb(runner, adbPath, [
      "-s",
      serial,
      "push",
      options.localArtifactPath ?? localArtifactPath,
      remoteArtifactPath,
    ]);
    server = await adb(
      runner,
      adbPath,
      [
        "-s",
        serial,
        "shell",
        `CLASSPATH=${remoteArtifactPath}`,
        "app_process",
        "/",
        "dev.droidwebscr.server.MainKt",
        "--verify-once",
        socketName,
      ],
      { background: true },
    );
    await waitForServerReady(
      server,
      () => serverOutput(server).stdout.includes(`droid-webscr:ready:${socketName}`),
      options.readinessTimeoutMs ?? 5_000,
    );

    const forward = await adb(runner, adbPath, [
      "-s",
      serial,
      "forward",
      "tcp:0",
      `localabstract:${socketName}`,
    ]);
    forwardedPort = parseForwardedPort(forward.stdout);
    socket = await connectSocket(forwardedPort);
    await socket.writeFrame(
      createFrame(messageTypeSessionHello, 1n, streamIdSession, new Uint8Array()),
    );
    assertFrame(await socket.readFrame(), messageTypeSessionHelloAck);
    const videoConfig = await socket.readFrame();
    assertFrame(videoConfig, messageTypeVideoConfig);
    const videoFrame = await socket.readFrame();
    assertFrame(videoFrame, messageTypeVideoFrame);

    const configPayload = payload(videoConfig);
    const framePayload = payload(videoFrame);
    if (configPayload.byteLength < 16) {
      throw new Error("Android video config payload is shorter than its 16-byte metadata header.");
    }
    const h264 = new Uint8Array(configPayload.byteLength - 16 + framePayload.byteLength);
    h264.set(configPayload.slice(16), 0);
    h264.set(framePayload, configPayload.byteLength - 16);
    const h264Path = await writeOutput(h264);
    const output = serverOutput(server);

    result = {
      forwardedPort,
      h264: h264Path,
      serverStderr: output.stderr,
      serverStdout: output.stdout,
      videoConfigBytes: configPayload.byteLength,
      videoFrameBytes: framePayload.byteLength,
    };
  } catch (error) {
    operationError = error;
    operationFailed = true;
  }

  const cleanupErrors = await cleanupDumpResources({
    adbPath,
    forwardedPort,
    runner,
    serial,
    server,
    socket,
  });
  if (operationFailed) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        `Android video frame dump failed: ${formatError(operationError)}; cleanup failed: ${cleanupErrors.map(formatError).join("; ")}`,
      );
    }
    throw operationError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `Android video frame dump cleanup failed: ${cleanupErrors.map(formatError).join("; ")}`,
    );
  }
  return result;
}

async function cleanupDumpResources({ adbPath, forwardedPort, runner, serial, server, socket }) {
  const errors = [];
  try {
    server?.process?.kill();
  } catch (error) {
    errors.push(error);
  }

  const cleanup = [];
  if (socket) {
    cleanup.push(Promise.resolve().then(() => socket.close()));
  }
  if (forwardedPort !== undefined) {
    cleanup.push(
      adb(runner, adbPath, ["-s", serial, "forward", "--remove", `tcp:${forwardedPort}`]),
    );
  }
  const settled = await Promise.allSettled(cleanup);
  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      errors.push(outcome.reason);
    }
  }
  return errors;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function createFrame(type, sequence, streamId, framePayload) {
  const output = new Uint8Array(headerLength + framePayload.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x44575343, false);
  view.setUint16(4, 1, false);
  view.setUint16(6, headerLength, false);
  view.setUint16(8, type, false);
  view.setUint32(12, streamId, false);
  view.setUint32(16, framePayload.byteLength, false);
  view.setBigUint64(28, sequence, false);
  output.set(framePayload, headerLength);
  return output;
}

function assertFrame(frame, type) {
  if (!frame) {
    throw new Error(`Expected frame type ${type}, but the Android server closed the stream.`);
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (view.getUint16(8, false) !== type) {
    throw new Error(`Expected frame type ${type}, got ${view.getUint16(8, false)}`);
  }
}

function payload(frame) {
  return frame.slice(headerLength);
}

function parseForwardedPort(stdout) {
  const match = stdout.trim().match(/^(?:tcp:)?(\d+)$/);
  const port = Number.parseInt(match?.[1] ?? "", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`adb forward did not return a valid TCP port: ${stdout.trim()}`);
  }
  return port;
}

function serverOutput(server) {
  return server.output?.() ?? { stderr: server.stderr ?? "", stdout: server.stdout ?? "" };
}

async function adb(runner, adbPath, args, options = {}) {
  const result = await runner.run({
    args,
    background: options.background ?? false,
    cwd: root,
    executable: adbPath,
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(result.stderr.trim() || `${adbPath} ${args.join(" ")} failed.`);
  }
  return result;
}

async function writeDefaultOutput(bytes) {
  await mkdir(outputDir, { recursive: true });
  const outputPath = new URL("first-frame.h264", outputDir);
  await writeFile(outputPath, bytes);
  return fileURLToPath(outputPath);
}

async function connectProtocolSocket(port) {
  const connection = await connect(port);
  return {
    close: async () => {
      connection.destroy();
      await new Promise((resolve) => setImmediate(resolve));
    },
    readFrame: async () => readFrame(connection),
    writeFrame: async (frame) => writeAll(connection, frame),
  };
}

function connect(localPort) {
  return new Promise((resolve, reject) => {
    const connection = net.connect({ host: "127.0.0.1", port: localPort });
    connection.once("connect", () => resolve(connection));
    connection.once("error", reject);
  });
}

async function readFrame(connection) {
  const header = await readExactly(connection, headerLength);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const length = view.getUint32(16, false);
  const frame = new Uint8Array(headerLength + length);
  frame.set(header);
  if (length > 0) {
    frame.set(await readExactly(connection, length), headerLength);
  }
  return frame;
}

async function readExactly(connection, length) {
  const chunks = [];
  let total = 0;
  const collect = async () => {
    const chunk = connection.read(length - total);
    if (chunk) {
      chunks.push(chunk);
      total += chunk.byteLength;
      return total >= length ? undefined : collect();
    }
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        connection.off("readable", onReadable);
        connection.off("error", onError);
        connection.off("end", onEnd);
      };
      const onReadable = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onEnd = () => {
        cleanup();
        reject(new Error("Socket ended"));
      };
      connection.once("readable", onReadable);
      connection.once("error", onError);
      connection.once("end", onEnd);
    });
    return collect();
  };
  await collect();

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function writeAll(socket, bytes) {
  return new Promise((resolve, reject) => {
    socket.write(bytes, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function createProcessRunner() {
  return {
    run: async ({ args, background = false, cwd, executable }) =>
      new Promise((resolve) => {
        const child = spawn(executable, args, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        const stdout = [];
        const stderr = [];
        let commandResolved = false;
        let resolveExit;
        const exit = new Promise((resolveProcessExit) => {
          resolveExit = resolveProcessExit;
        });
        const output = () => ({
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdout: Buffer.concat(stdout).toString("utf8"),
        });
        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));
        child.on("error", (error) => {
          const result = {
            status: 1,
            stderr: error.message,
            stdout: output().stdout,
          };
          resolveExit(result);
          if (!commandResolved) {
            commandResolved = true;
            resolve(result);
          }
        });

        if (background) {
          child.on("spawn", () => {
            commandResolved = true;
            resolve({
              exit,
              output,
              process: child,
              status: 0,
              stderr: "",
              stdout: "",
            });
          });
        }

        child.on("close", (status) => {
          const result = {
            status: status ?? 1,
            ...output(),
          };
          resolveExit(result);
          if (!background && !commandResolved) {
            commandResolved = true;
            resolve(result);
          }
        });
      }),
  };
}

async function waitForServerReady(server, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  await new Promise((resolve, reject) => {
    let completed = false;
    let timer;
    const finish = (callback, value) => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timer);
      callback(value);
    };
    const poll = () => {
      if (predicate()) {
        finish(resolve);
        return;
      }
      if (Date.now() >= deadline) {
        finish(reject, new Error("Timed out waiting for Android server readiness"));
        return;
      }
      timer = setTimeout(poll, Math.min(50, deadline - Date.now()));
    };

    server.exit?.then(
      (result) => {
        const message =
          result.stderr.trim() ||
          result.stdout.trim() ||
          `Android server exited with status ${result.status} before reporting readiness.`;
        finish(reject, new Error(message));
      },
      (error) => finish(reject, error),
    );
    poll();
  });
}
