import { access, mkdir, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";

const root = fileURLToPath(new URL("../", import.meta.url));
const remoteArtifactPath = "/data/local/tmp/droid-webscr-server.jar";
const socketName = "droid-webscr";
const localArtifactPath = "android/server/build/droid-webscr-server-android.jar";
const frameHeaderLength = 40;
const frameMagic = 0x44575343;
const wireVersion = 1;
const messageTypeSessionHello = 0x0001;
const messageTypeSessionHelloAck = 0x0002;
const messageTypeVideoConfig = 0x0201;
const messageTypeVideoFrame = 0x0202;
const messageTypeVideoReconfigure = 0x0203;
const messageTypeControlPointer = 0x0301;
const messageTypeControlKey = 0x0302;
const messageTypeControlText = 0x0303;
const messageTypeControlSystem = 0x0304;
const messageTypeControlClipboard = 0x0305;
const messageTypeLogRecord = 0x0401;
const streamIdSession = 1;
const streamIdVideo = 3;
const streamIdControl = 4;
const streamIdLog = 5;
const helloSequence = 1n;

export async function runAndroidEmulatorVerification(options = {}) {
  const runner = options.runner ?? createProcessRunner();
  const adbPath = options.adbPath ?? (await findAdbPath());
  const artifactPath = options.artifactPath ?? localArtifactPath;
  const buildServerArtifact = options.buildServerArtifact ?? buildAndroidServerArtifact;
  const connectTcpSocket = options.connectTcpSocket ?? connectTcpProtocolSocket;
  let forwardedPort;
  let server;

  const devices = await listOnlineEmulators(runner, adbPath);
  if (devices.length === 0) {
    throw new Error("No online Android emulator was reported by adb devices -l.");
  }

  const serial = devices[0].serial;

  try {
    await buildServerArtifact({ artifactPath, runner });
    await adb(runner, adbPath, serial, ["shell", "rm", "-f", remoteArtifactPath]);
    await adb(runner, adbPath, serial, ["push", artifactPath, remoteArtifactPath]);
    server = await adb(
      runner,
      adbPath,
      serial,
      [
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

    const forward = await adb(runner, adbPath, serial, [
      "forward",
      "tcp:0",
      `localabstract:${socketName}`,
    ]);
    forwardedPort = parseForwardedPort(forward.stdout);
    const productVerification = await verifyProductRoundTrip(connectTcpSocket, forwardedPort);

    return { forwardedPort, serial, ...productVerification };
  } catch (error) {
    const output = server?.output?.();
    if (output && (output.stdout || output.stderr)) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nAndroid server stdout:\n${output.stdout}\nAndroid server stderr:\n${output.stderr}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (forwardedPort !== undefined) {
      await adb(runner, adbPath, serial, ["forward", "--remove", `tcp:${forwardedPort}`], {
        allowFailure: true,
      });
    }
    await adb(runner, adbPath, serial, ["shell", "rm", "-f", remoteArtifactPath], {
      allowFailure: true,
    });
    server?.process?.kill();
  }
}

async function verifyHelloRoundTrip(connectTcpSocket, forwardedPort) {
  const deadline = Date.now() + 5_000;
  return verifyHelloRoundTripAttempt(connectTcpSocket, forwardedPort, deadline);
}

async function verifyProductRoundTrip(connectTcpSocket, forwardedPort) {
  const socket = await verifyHelloRoundTrip(connectTcpSocket, forwardedPort);
  try {
    const videoConfig = await withTimeout(
      socket.readFrame(),
      5_000,
      "Timed out waiting for VIDEO_CONFIG from Android server.",
    );
    assertFrame(videoConfig, {
      messageType: messageTypeVideoConfig,
      minPayloadLength: 16,
      streamId: streamIdVideo,
    });

    const videoFrame = await withTimeout(
      socket.readFrame(),
      5_000,
      "Timed out waiting for VIDEO_FRAME from Android server.",
    );
    assertFrame(videoFrame, {
      messageType: messageTypeVideoFrame,
      minPayloadLength: 1,
      streamId: streamIdVideo,
    });

    const controlFrames = [
      { expectation: "control:pointer:Accepted", frame: createControlPointerFrame() },
      { expectation: "control:key:Accepted", frame: createControlKeyFrame() },
      { expectation: "control:text:Accepted", frame: createControlTextFrame("hello") },
      { expectation: "control:home:Accepted", frame: createControlSystemFrame() },
      {
        expectation: "clipboard:set:Rejected(Clipboard sync is disabled by policy.)",
        frame: createControlClipboardFrame(),
      },
      { expectation: "video:reconfigure:Accepted", frame: createVideoReconfigureFrame() },
    ];
    const controlLogs = await verifyControlFrames(socket, controlFrames);

    return {
      controlLogBytes: controlLogs.reduce(
        (total, logText) => total + new TextEncoder().encode(logText).byteLength,
        0,
      ),
      controlLogs,
      videoConfigBytes: framePayloadLength(videoConfig),
      videoFrameBytes: framePayloadLength(videoFrame),
    };
  } finally {
    await socket.close();
  }
}

async function verifyHelloRoundTripAttempt(connectTcpSocket, forwardedPort, deadline, lastError) {
  if (Date.now() >= deadline) {
    throw lastError ?? new Error("Timed out verifying SESSION_HELLO_ACK from Android server.");
  }

  let socket;
  try {
    socket = await withTimeout(
      connectTcpSocket(forwardedPort),
      1_000,
      `Timed out connecting to Android server on forwarded tcp:${forwardedPort}.`,
    );
    await withTimeout(
      socket.writeFrame(createHelloFrame()),
      1_000,
      "Timed out writing SESSION_HELLO.",
    );
    const response = await withTimeout(
      socket.readFrame(),
      1_000,
      "Timed out waiting for SESSION_HELLO_ACK from Android server.",
    );
    assertHelloAck(response);
    return socket;
  } catch (error) {
    await socket?.close();
    await delay(100);
    return verifyHelloRoundTripAttempt(connectTcpSocket, forwardedPort, deadline, error);
  }
}

async function connectWithRetry(port, attemptsRemaining = 40, lastError) {
  if (attemptsRemaining <= 0) {
    throw lastError;
  }

  try {
    return await new Promise((resolveSocket, rejectSocket) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => resolveSocket(socket));
      socket.once("error", rejectSocket);
    });
  } catch (error) {
    await delay(100);
    return connectWithRetry(port, attemptsRemaining - 1, error);
  }
}

async function readExactly(socket, length, chunks = [], total = 0) {
  if (total >= length) {
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  if (socket.destroyed || socket.closed) {
    throw new Error("Socket closed before a complete frame arrived.");
  }

  const chunk = socket.read(length - total);
  if (chunk) {
    return readExactly(socket, length, [...chunks, chunk], total + chunk.byteLength);
  }

  await onceReadable(socket);
  return readExactly(socket, length, chunks, total);
}
export function createHelloAckFrame() {
  return createFrame(messageTypeSessionHelloAck, helloSequence);
}

export function createVideoConfigFrame() {
  const payload = new Uint8Array(17);
  payload[0] = 1;
  payload[1] = 1;
  payload[15] = 1;
  payload[16] = 0x67;
  return createFrame(messageTypeVideoConfig, 2n, {
    payload,
    streamId: streamIdVideo,
  });
}

export function createVideoFrame() {
  return createFrame(messageTypeVideoFrame, 3n, {
    flags: 1,
    payload: new Uint8Array([0, 0, 0, 1, 0x65]),
    streamId: streamIdVideo,
  });
}

export function createLogFrame(text = "control:home:Accepted") {
  return createLogFrameWithText(text);
}

function createLogFrameWithText(text) {
  return createFrame(messageTypeLogRecord, 4n, {
    payload: new TextEncoder().encode(text),
    streamId: streamIdLog,
  });
}

function createHelloFrame() {
  return createFrame(messageTypeSessionHello, helloSequence);
}

function createControlSystemFrame() {
  return createFrame(messageTypeControlSystem, 2n, {
    payload: new Uint8Array([1]),
    streamId: streamIdControl,
  });
}

function createControlPointerFrame() {
  const payload = new Uint8Array(20);
  const view = new DataView(payload.buffer);
  view.setUint8(0, 0);
  view.setUint16(2, 1, false);
  view.setUint32(4, 24, false);
  view.setUint32(8, 48, false);
  view.setUint8(12, 255);
  view.setUint16(14, 1, false);
  view.setUint32(16, 0, false);
  return createFrame(messageTypeControlPointer, 3n, { payload, streamId: streamIdControl });
}

function createControlKeyFrame() {
  const payload = new Uint8Array(12);
  const view = new DataView(payload.buffer);
  view.setUint8(0, 0);
  view.setUint16(2, 66, false);
  view.setUint32(4, 0, false);
  view.setUint32(8, 0, false);
  return createFrame(messageTypeControlKey, 4n, { payload, streamId: streamIdControl });
}

function createControlTextFrame(text) {
  return createFrame(messageTypeControlText, 5n, {
    payload: new TextEncoder().encode(text),
    streamId: streamIdControl,
  });
}

function createControlClipboardFrame() {
  const text = new TextEncoder().encode("blocked");
  const payload = new Uint8Array(1 + text.byteLength);
  payload[0] = 0;
  payload.set(text, 1);
  return createFrame(messageTypeControlClipboard, 7n, { payload, streamId: streamIdControl });
}

function createVideoReconfigureFrame() {
  const payload = new Uint8Array(8);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 4, false);
  view.setUint32(4, 45, false);
  return createFrame(messageTypeVideoReconfigure, 8n, { payload, streamId: streamIdVideo });
}

function createFrame(type, sequence, options = {}) {
  const payload = options.payload ?? new Uint8Array(0);
  const output = new Uint8Array(frameHeaderLength + payload.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, frameMagic, false);
  view.setUint16(4, wireVersion, false);
  view.setUint16(6, frameHeaderLength, false);
  view.setUint16(8, type, false);
  view.setUint16(10, options.flags ?? 0, false);
  view.setUint32(12, options.streamId ?? streamIdSession, false);
  view.setUint32(16, payload.byteLength, false);
  view.setBigUint64(20, 0n, false);
  view.setBigUint64(28, sequence, false);
  view.setUint32(36, 0, false);
  output.set(payload, frameHeaderLength);
  return output;
}

function assertHelloAck(frame) {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.byteLength !== frameHeaderLength) {
    throw new Error(`SESSION_HELLO_ACK frame length was ${bytes.byteLength}, expected 40.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== frameMagic) {
    throw new Error("SESSION_HELLO_ACK frame had invalid magic.");
  }
  if (view.getUint16(4, false) !== wireVersion) {
    throw new Error("SESSION_HELLO_ACK frame had unsupported wire version.");
  }
  if (view.getUint16(6, false) !== frameHeaderLength) {
    throw new Error("SESSION_HELLO_ACK frame had unsupported header length.");
  }
  if (view.getUint16(8, false) !== messageTypeSessionHelloAck) {
    throw new Error("Android server did not respond with SESSION_HELLO_ACK.");
  }
  if (view.getUint16(10, false) !== 0) {
    throw new Error("SESSION_HELLO_ACK frame had non-zero flags.");
  }
  if (view.getUint32(12, false) !== streamIdSession) {
    throw new Error("SESSION_HELLO_ACK frame did not use the session stream.");
  }
  if (view.getUint32(16, false) !== 0) {
    throw new Error("SESSION_HELLO_ACK frame had an unexpected payload.");
  }
  if (view.getBigUint64(28, false) !== helloSequence) {
    throw new Error("SESSION_HELLO_ACK frame did not echo the SESSION_HELLO sequence.");
  }
  if (view.getUint32(36, false) !== 0) {
    throw new Error("SESSION_HELLO_ACK frame had non-zero reserved bits.");
  }
}

function assertFrame(frame, expectation) {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.byteLength < frameHeaderLength + expectation.minPayloadLength) {
    throw new Error(
      `Frame length was ${bytes.byteLength}, expected at least ${frameHeaderLength + expectation.minPayloadLength}.`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== frameMagic) {
    throw new Error("Frame had invalid magic.");
  }
  if (view.getUint16(4, false) !== wireVersion) {
    throw new Error("Frame had unsupported wire version.");
  }
  if (view.getUint16(6, false) !== frameHeaderLength) {
    throw new Error("Frame had unsupported header length.");
  }
  if (view.getUint16(8, false) !== expectation.messageType) {
    throw new Error(`Unexpected message type ${view.getUint16(8, false)}.`);
  }
  if (view.getUint32(12, false) !== expectation.streamId) {
    throw new Error(`Unexpected stream id ${view.getUint32(12, false)}.`);
  }
  if (view.getUint32(16, false) < expectation.minPayloadLength) {
    throw new Error("Frame payload was shorter than expected.");
  }
}

function framePayloadLength(frame) {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(16, false);
}

function payloadBytes(frame) {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  return bytes.slice(frameHeaderLength);
}

async function readLogText(socket, expectation = "control") {
  const logFrame = await withTimeout(
    socket.readFrame(),
    5_000,
    `Timed out waiting for ${expectation} LOG_RECORD from Android server.`,
  );
  assertFrame(logFrame, {
    messageType: messageTypeLogRecord,
    minPayloadLength: 1,
    streamId: streamIdLog,
  });
  return new TextDecoder().decode(payloadBytes(logFrame));
}

async function verifyControlFrames(socket, controlFrames, index = 0, logs = []) {
  if (index >= controlFrames.length) {
    return logs;
  }
  const { expectation, frame } = controlFrames[index];
  await withTimeout(socket.writeFrame(frame), 1_000, `Timed out writing ${expectation}.`);
  const logText = await readLogText(socket, expectation);
  if (logText !== expectation) {
    throw new Error(
      `Android control operation mismatch: expected "${expectation}", got "${logText}".`,
    );
  }
  return verifyControlFrames(socket, controlFrames, index + 1, [...logs, logText]);
}

async function listOnlineEmulators(runner, adbPath) {
  const result = await adb(runner, adbPath, undefined, ["devices", "-l"]);
  return result.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /^\S+\s+device\b/.test(line))
    .map((line) => ({ serial: line.split(/\s+/)[0] }))
    .filter((device) => /^emulator-\d+$/.test(device.serial));
}

async function adb(runner, adbPath, serial, args, options = {}) {
  const fullArgs = serial ? ["-s", serial, ...args] : args;
  const result = await runner.run({
    args: fullArgs,
    background: options.background ?? false,
    cwd: root,
    executable: adbPath,
  });

  if (!options.allowFailure && result.status !== 0) {
    throw new Error(result.stderr.trim() || `${adbPath} ${fullArgs.join(" ")} failed.`);
  }
  return result;
}

async function buildAndroidServerArtifact({ artifactPath, runner }) {
  const gradle = await findGradlePath();
  await runChecked(runner, {
    args: ["installDist", "--warning-mode", "fail"],
    cwd: join(root, "android", "server"),
    executable: gradle,
  });

  const d8 = await findD8Path();
  const androidJar = await findLatestAndroidJar();
  const inputJars = await listServerDistributionJars();
  await mkdir(dirname(resolve(root, artifactPath)), { recursive: true });
  await runChecked(runner, {
    args: ["--lib", androidJar, "--min-api", "23", "--output", artifactPath, ...inputJars],
    cwd: root,
    executable: d8,
  });
  if (!(await readableExists(resolve(root, artifactPath)))) {
    throw new Error(`D8 completed without creating ${artifactPath}.`);
  }
}

async function runChecked(runner, command) {
  const result = await runner.run(command);
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || `${command.executable} ${command.args.join(" ")} failed.`,
    );
  }
  return result;
}

async function listServerDistributionJars() {
  const installDirectory = join(root, "android", "server", "build", "install");
  const distributions = await readdir(installDirectory, { withFileTypes: true });
  const libDirectoryEntry = distributions.find((entry) => entry.isDirectory());
  if (!libDirectoryEntry) {
    throw new Error(`No Gradle distribution directory was found under ${installDirectory}.`);
  }

  const libDirectory = join(installDirectory, libDirectoryEntry.name, "lib");
  const entries = await readdir(libDirectory);
  const jars = entries
    .filter((entry) => entry.endsWith(".jar"))
    .map((entry) => join(libDirectory, entry));
  if (jars.length === 0) {
    throw new Error(`No Gradle distribution jars were found under ${libDirectory}.`);
  }
  return jars;
}

function parseForwardedPort(stdout) {
  const match = stdout.match(/(?:tcp:)?(\d+)/);
  if (!match) {
    throw new Error(`adb forward did not report an allocated tcp port: ${stdout.trim()}`);
  }
  return Number.parseInt(match[1], 10);
}

async function connectTcpProtocolSocket(port) {
  const socket = await connectWithRetry(port);
  return {
    close: async () => {
      socket.destroy();
      await delay(0);
    },
    readFrame: async () => readProtocolFrame(socket),
    writeFrame: async (frame) => {
      await writeAll(socket, frame);
    },
  };
}

async function readProtocolFrame(socket) {
  const header = await readExactly(socket, frameHeaderLength);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const payloadLength = view.getUint32(16, false);
  if (payloadLength === 0) {
    return header;
  }
  const payload = await readExactly(socket, payloadLength);
  const frame = new Uint8Array(frameHeaderLength + payloadLength);
  frame.set(header);
  frame.set(payload, frameHeaderLength);
  return frame;
}

function onceReadable(socket) {
  return new Promise((resolveReadable, rejectReadable) => {
    const cleanup = () => {
      socket.off("readable", onReadable);
      socket.off("error", onError);
      socket.off("end", onEnd);
      socket.off("close", onClose);
    };
    const onReadable = () => {
      cleanup();
      resolveReadable();
    };
    const onError = (error) => {
      cleanup();
      rejectReadable(error);
    };
    const onEnd = () => {
      cleanup();
      rejectReadable(new Error("Socket ended before a complete frame arrived."));
    };
    const onClose = () => {
      cleanup();
      resolveReadable();
    };
    socket.once("readable", onReadable);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.once("close", onClose);
  });
}

function writeAll(socket, bytes) {
  return new Promise((resolveWrite, rejectWrite) => {
    socket.write(bytes, (error) => {
      if (error) {
        rejectWrite(error);
      } else {
        resolveWrite();
      }
    });
  });
}

function createProcessRunner() {
  return {
    run: async ({ args, background = false, cwd, executable }) =>
      new Promise((resolveRun) => {
        const command = processCommand(executable, args);
        const child = spawn(command.executable, command.args, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout = [];
        const stderr = [];
        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));
        child.on("error", (error) => {
          resolveRun({
            pid: child.pid,
            status: 1,
            stderr: error.message,
            stdout: Buffer.concat(stdout).toString("utf8"),
          });
        });

        if (background) {
          resolveRun({
            output: () => ({
              stderr: Buffer.concat(stderr).toString("utf8"),
              stdout: Buffer.concat(stdout).toString("utf8"),
            }),
            pid: child.pid,
            process: child,
            status: 0,
            stderr: "",
            stdout: "",
          });
          return;
        }

        child.on("close", (status) => {
          resolveRun({
            pid: child.pid,
            status: status ?? 1,
            stderr: Buffer.concat(stderr).toString("utf8"),
            stdout: Buffer.concat(stdout).toString("utf8"),
          });
        });
      }),
  };
}

function processCommand(executable, args) {
  if (process.platform === "win32" && /\.(bat|cmd)$/i.test(executable)) {
    return {
      args: ["/d", "/c", executable, ...args],
      executable: "cmd.exe",
    };
  }

  return { args, executable };
}

async function findAdbPath() {
  const names = process.platform === "win32" ? ["adb.exe", "adb.cmd", "adb.bat"] : ["adb"];
  const candidates = executableCandidates(names, [
    process.env.ANDROID_HOME ? join(process.env.ANDROID_HOME, "platform-tools") : undefined,
    process.env.ANDROID_SDK_ROOT ? join(process.env.ANDROID_SDK_ROOT, "platform-tools") : undefined,
    ...(process.env.PATH ?? "").split(delimiter),
  ]);
  const adbPath = await firstExecutable(candidates);
  if (!adbPath) {
    throw new Error("adb was not found. Install Android SDK platform-tools or set ANDROID_HOME.");
  }
  return adbPath;
}

async function findGradlePath() {
  const wrapper = join(
    root,
    "android",
    "server",
    process.platform === "win32" ? "gradlew.bat" : "gradlew",
  );
  if (await executableExists(wrapper)) {
    return wrapper;
  }

  const names =
    process.platform === "win32" ? ["gradle.bat", "gradle.cmd", "gradle.exe"] : ["gradle"];
  const gradlePath = await firstExecutable(
    executableCandidates(names, (process.env.PATH ?? "").split(delimiter)),
  );
  if (!gradlePath) {
    throw new Error(
      "Gradle was not found. Install/use the repository-pinned Gradle tool through mise or add android/server/gradlew(.bat).",
    );
  }
  return gradlePath;
}

async function findD8Path() {
  const sdk = androidSdkRoot();
  const candidates = [
    join(sdk, "cmdline-tools", "latest", "bin", process.platform === "win32" ? "d8.bat" : "d8"),
    ...(await androidVersionedToolCandidates(
      join(sdk, "build-tools"),
      process.platform === "win32" ? "d8.bat" : "d8",
    )),
  ];
  const d8 = await firstExecutable(candidates);
  if (!d8) {
    throw new Error(
      "d8 was not found under the Android SDK build-tools or cmdline-tools directories.",
    );
  }
  return d8;
}

async function findLatestAndroidJar() {
  const candidates = await androidVersionedToolCandidates(
    join(androidSdkRoot(), "platforms"),
    "android.jar",
  );
  const androidJar = await firstReadable(candidates);
  if (!androidJar) {
    throw new Error("No android.jar was found under the Android SDK platforms directory.");
  }
  return androidJar;
}

async function androidVersionedToolCandidates(directory, toolName) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        path: join(directory, entry.name, toolName),
        version: Number.parseInt(entry.name.replace(/\D/g, ""), 10),
      }))
      .filter((entry) => Number.isFinite(entry.version))
      .toSorted((left, right) => right.version - left.version)
      .map((entry) => entry.path);
  } catch {
    return [];
  }
}

function androidSdkRoot() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdk) {
    throw new Error("ANDROID_HOME or ANDROID_SDK_ROOT must point to an Android SDK.");
  }
  return sdk;
}

function executableCandidates(names, directories) {
  return directories
    .filter((directory) => directory && directory.length > 0)
    .flatMap((directory) => names.map((name) => join(directory, name)));
}

async function firstExecutable(candidates) {
  const checks = await Promise.all(
    candidates.map(async (candidate) =>
      (await executableExists(candidate)) ? candidate : undefined,
    ),
  );
  return checks.find(Boolean);
}

async function firstReadable(candidates) {
  const checks = await Promise.all(
    candidates.map(async (candidate) =>
      (await readableExists(candidate)) ? candidate : undefined,
    ),
  );
  return checks.find(Boolean);
}

async function executableExists(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readableExists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function withTimeout(promise, ms, message) {
  const guardedPromise = Promise.resolve(promise);
  guardedPromise.catch(() => {});
  let timer;
  return Promise.race([
    guardedPromise,
    new Promise((_, rejectTimeout) => {
      timer = setTimeout(() => rejectTimeout(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
