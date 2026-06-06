import { AdbProvider } from "@droid-webscr/adb";
import { StartedDeviceSession } from "../session/device-session.js";

export interface DeviceServer {
  start(serial: string): Promise<StartedDeviceSession>;
}

export class AdbDeviceServer implements DeviceServer {
  public constructor(private readonly adbProvider: AdbProvider) {}

  public async start(serial: string): Promise<StartedDeviceSession> {
    const session = await this.adbProvider.connect(serial);
    const socket = await session.openSocket("localabstract:droid-webscr");
    return {
      frames: socket.chunks,
      serial,
      stop: async () => {
        await socket.close();
        await session.close();
      },
      write: async (frame) => {
        await socket.write(frame);
      },
    };
  }
}
