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
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    void deviceSession.write(bytes).catch(close);
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
