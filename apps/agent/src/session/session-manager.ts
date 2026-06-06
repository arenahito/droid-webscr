import { AdbProvider, isUsableDevice } from "@droid-webscr/adb";
import { createSessionToken, SessionTokenRecord } from "../security/session-token.js";

export interface CreateSessionResult {
  readonly serial: string;
  readonly sessionId: string;
  readonly token: string;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionTokenRecord>();

  public constructor(
    private readonly adbProvider: AdbProvider,
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = 60_000,
  ) {}

  public async create(deviceSerial: string): Promise<CreateSessionResult> {
    const devices = await this.adbProvider.listDevices();
    const device = devices.find((item) => item.serial === deviceSerial);
    if (!device || !isUsableDevice(device)) {
      throw new Error("Device is not available for session creation.");
    }
    const sessionId = crypto.randomUUID();
    const record = createSessionToken(sessionId, deviceSerial, this.now(), this.ttlMs);
    this.sessions.set(sessionId, record);
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

  public delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
