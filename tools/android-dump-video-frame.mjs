import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";

const root = new URL("../", import.meta.url);
const outputDir = new URL("../.tasks/evidence/android-video-dump/", import.meta.url);
const remoteArtifactPath = "/data/local/tmp/droid-webscr-server.jar";
const localArtifactPath = new URL(
  "../android/server/build/droid-webscr-server-android.jar",
  import.meta.url,
);
const socketName = "droid-webscr";
const headerLength = 40;
const messageTypeSessionHello = 0x0001;
const messageTypeSessionHelloAck = 0x0002;
const messageTypeVideoConfig = 0x0201;
const messageTypeVideoFrame = 0x0202;
const streamIdSession = 1;

await mkdir(outputDir, { recursive: true });
await adb(["-s", "emulator-5554", "forward", "--remove-all"], { allowFailure: true });
await adb(["-s", "emulator-5554", "shell", "pkill", "-f", "droid-webscr-server.jar"], {
  allowFailure: true,
});
await adb(["-s", "emulator-5554", "push", fileURLToPath(localArtifactPath), remoteArtifactPath]);
const server = spawn(
  "adb",
  [
    "-s",
    "emulator-5554",
    "shell",
    `CLASSPATH=${remoteArtifactPath}`,
    "app_process",
    "/",
    "dev.droidwebscr.server.MainKt",
    "--verify-once",
    socketName,
  ],
  { cwd: fileURLToPath(root), stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
);
let serverStdout = "";
let serverStderr = "";
server.stdout.on("data", (chunk) => {
  serverStdout += chunk.toString("utf8");
});
server.stderr.on("data", (chunk) => {
  serverStderr += chunk.toString("utf8");
});
await waitFor(() => serverStdout.includes(`droid-webscr:ready:${socketName}`), 5000);
const forward = await adb([
  "-s",
  "emulator-5554",
  "forward",
  "tcp:0",
  `localabstract:${socketName}`,
]);
const port = Number.parseInt(forward.match(/\d+/)?.[0] ?? "", 10);
if (!Number.isFinite(port)) {
  throw new Error(`adb forward did not return a port: ${forward}`);
}
const socket = await connect(port);
socket.write(createFrame(messageTypeSessionHello, 1n, streamIdSession, new Uint8Array()));
assertFrame(await readFrame(socket), messageTypeSessionHelloAck);
const videoConfig = await readFrame(socket);
assertFrame(videoConfig, messageTypeVideoConfig);
const videoFrame = await readFrame(socket);
assertFrame(videoFrame, messageTypeVideoFrame);
const configPayload = payload(videoConfig);
const framePayload = payload(videoFrame);
const h264 = new Uint8Array(configPayload.byteLength - 16 + framePayload.byteLength);
h264.set(configPayload.slice(16), 0);
h264.set(framePayload, configPayload.byteLength - 16);
await writeFile(new URL("first-frame.h264", outputDir), h264);
socket.destroy();
server.kill();
await adb(["-s", "emulator-5554", "forward", "--remove", `tcp:${port}`], { allowFailure: true });
console.log(
  JSON.stringify({
    h264: fileURLToPath(new URL("first-frame.h264", outputDir)),
    serverStderr,
    serverStdout,
    videoConfigBytes: configPayload.byteLength,
    videoFrameBytes: framePayload.byteLength,
  }),
);

function createFrame(type, sequence, streamId, framePayloadInput) {
  const output = new Uint8Array(headerLength + framePayloadInput.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x44575343, false);
  view.setUint16(4, 1, false);
  view.setUint16(6, headerLength, false);
  view.setUint16(8, type, false);
  view.setUint32(12, streamId, false);
  view.setUint32(16, framePayloadInput.byteLength, false);
  view.setBigUint64(28, sequence, false);
  output.set(framePayloadInput, headerLength);
  return output;
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

function assertFrame(frame, type) {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (view.getUint16(8, false) !== type) {
    throw new Error(`Expected frame type ${type}, got ${view.getUint16(8, false)}`);
  }
}

function payload(frame) {
  return frame.slice(headerLength);
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
      connection.once("readable", resolve);
      connection.once("error", reject);
      connection.once("end", () => reject(new Error("Socket ended")));
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

function connect(localPort) {
  return new Promise((resolve, reject) => {
    const connection = net.connect({ host: "127.0.0.1", port: localPort });
    connection.once("connect", () => resolve(connection));
    connection.once("error", reject);
  });
}

async function adb(args, options = {}) {
  const result = await run("adb", args);
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(result.stderr || `adb ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function run(executable, args) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd: fileURLToPath(root), windowsHide: true });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (status) => {
      resolve({
        status: status ?? 1,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
  });
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const poll = async () => {
    if (predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Android server readiness");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    return poll();
  };
  await poll();
}

function fileURLToPath(url) {
  return decodeURIComponent(url.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
}
