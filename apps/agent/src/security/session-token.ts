import { randomBytes } from "node:crypto";

export interface SessionTokenRecord {
  readonly deviceSerial: string;
  readonly expiresAtMs: number;
  readonly sessionId: string;
  readonly token: string;
  readonly video: SessionVideoSettings;
}

export interface SessionVideoSettings {
  readonly bitrateMbps: number;
  readonly fps: number;
}

export function createSessionToken(
  sessionId: string,
  deviceSerial: string,
  nowMs: number,
  ttlMs: number,
  video: SessionVideoSettings,
): SessionTokenRecord {
  return {
    deviceSerial,
    expiresAtMs: nowMs + ttlMs,
    sessionId,
    token: randomBytes(32).toString("base64url"),
    video,
  };
}

export function isTokenExpired(record: SessionTokenRecord, nowMs: number): boolean {
  return record.expiresAtMs <= nowMs;
}
