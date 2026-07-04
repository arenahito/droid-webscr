import { decodeFrame, MessageType } from "@droid-webscr/protocol";
import { BrowserBinarySocket } from "./browser-session.js";
import { StartedDeviceSession } from "./device-session.js";

export interface BridgeSession {
  close(): Promise<void>;
}

export function bridgeBrowserToDevice(
  socket: BrowserBinarySocket,
  deviceSession: StartedDeviceSession,
): BridgeSession {
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await deviceSession.stop();
    }
  };

  socket.on("message", (data) => {
    if (typeof data === "string") {
      return;
    }
    /* v8 ignore next -- browser binary messages are delivered as ArrayBuffer in production. */
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    void sendBrowserFrame(bytes, deviceSession).catch(close);
  });
  socket.on("close", () => {
    void close();
  });
  socket.on("error", () => {
    void close();
  });

  void forwardDeviceFrames(socket, deviceSession, close);

  return { close };
}

export async function sendBrowserFrame(
  frame: Uint8Array,
  deviceSession: StartedDeviceSession,
): Promise<void> {
  if (await injectScrollFrame(frame, deviceSession)) {
    return;
  }
  await deviceSession.write(frame);
}

async function injectScrollFrame(
  frame: Uint8Array,
  deviceSession: StartedDeviceSession,
): Promise<boolean> {
  if (!deviceSession.shell) {
    return false;
  }
  const decoded = decodeFrame(frame);
  if (!decoded.ok || decoded.value.header.type !== MessageType.ControlScroll) {
    return false;
  }
  const payload = decoded.value.payload;
  if (payload.byteLength !== 20) {
    return false;
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const x = view.getUint32(0, false);
  const y = view.getUint32(4, false);
  const horizontal = view.getFloat32(8, false);
  const vertical = view.getFloat32(12, false);
  const displayId = view.getUint32(16, false);
  const command = ["input", "mouse", "-d", String(displayId), "scroll", String(x), String(y)];
  if (horizontal !== 0) {
    command.push("--axis", `HSCROLL,${horizontal}`);
  }
  if (vertical !== 0) {
    command.push("--axis", `VSCROLL,${vertical}`);
  }
  return (await deviceSession.shell(command)) === 0;
}

async function forwardDeviceFrames(
  socket: BrowserBinarySocket,
  deviceSession: StartedDeviceSession,
  close: () => Promise<void>,
): Promise<void> {
  try {
    for await (const frame of deviceSession.frames) {
      socket.send(frame);
    }
  } finally {
    await close();
  }
}
