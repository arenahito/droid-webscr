import { AdbProvider, isUsableDevice } from "@droid-webscr/adb";
import {
  createSessionToken,
  SessionTokenRecord,
  SessionVideoSettings,
} from "../security/session-token.js";

export interface CreateSessionResult {
  readonly serial: string;
  readonly sessionId: string;
  readonly token: string;
}

export type { SessionVideoSettings };

export class SessionManager {
  private readonly sessions = new Map<string, SessionTokenRecord>();
  private readonly sessionsByDeviceSerial = new Map<string, string>();
  private readonly inFlightCreatesByDeviceSerial = new Map<string, Promise<CreateSessionResult>>();

  public constructor(
    private readonly adbProvider: AdbProvider,
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = 60_000,
  ) {}

  public create(deviceSerial: string, video: SessionVideoSettings): Promise<CreateSessionResult> {
    const inFlight = this.inFlightCreatesByDeviceSerial.get(deviceSerial);
    if (inFlight) {
      return inFlight;
    }
    this.deleteActiveSessionForDevice(deviceSerial);
    const created = this.createFresh(deviceSerial, video).finally(() => {
      this.inFlightCreatesByDeviceSerial.delete(deviceSerial);
    });
    this.inFlightCreatesByDeviceSerial.set(deviceSerial, created);
    return created;
  }

  private async createFresh(
    deviceSerial: string,
    video: SessionVideoSettings,
  ): Promise<CreateSessionResult> {
    const devices = await this.adbProvider.listDevices();
    this.deleteActiveSessionForDevice(deviceSerial);
    const device = devices.find((item) => item.serial === deviceSerial);
    if (!device || !isUsableDevice(device)) {
      throw new Error("Device is not available for session creation.");
    }
    const sessionId = crypto.randomUUID();
    const record = createSessionToken(sessionId, deviceSerial, this.now(), this.ttlMs, video);
    this.sessions.set(sessionId, record);
    this.sessionsByDeviceSerial.set(deviceSerial, sessionId);
    return {
      serial: deviceSerial,
      sessionId,
      token: record.token,
    };
  }

  public verify(sessionId: string, token: string | undefined): SessionTokenRecord | undefined {
    const record = this.sessions.get(sessionId);
    if (!record || record.token !== token || record.expiresAtMs <= this.now()) {
      return undefined;
    }
    return record;
  }

  public verifyForDevice(
    sessionId: string,
    token: string | undefined,
    deviceSerial: string,
  ): SessionTokenRecord | undefined {
    const record = this.verify(sessionId, token);
    return record?.deviceSerial === deviceSerial ? record : undefined;
  }

  public cleanupExpired(): number {
    let removed = 0;
    for (const [sessionId, record] of this.sessions) {
      if (record.expiresAtMs <= this.now()) {
        this.sessions.delete(sessionId);
        if (this.sessionsByDeviceSerial.get(record.deviceSerial) === sessionId) {
          this.sessionsByDeviceSerial.delete(record.deviceSerial);
        }
        removed += 1;
      }
    }
    return removed;
  }

  public delete(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (record && this.sessionsByDeviceSerial.get(record.deviceSerial) === sessionId) {
      this.sessionsByDeviceSerial.delete(record.deviceSerial);
    }
  }

  private deleteActiveSessionForDevice(deviceSerial: string): void {
    const sessionId = this.sessionsByDeviceSerial.get(deviceSerial);
    if (!sessionId) {
      return;
    }
    const record = this.sessions.get(sessionId);
    this.sessionsByDeviceSerial.delete(deviceSerial);
    if (record) {
      this.sessions.delete(sessionId);
    }
  }
}
