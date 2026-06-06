import { SessionTokenRecord, isTokenExpired } from "./session-token.js";

export function validateSessionToken(
  record: SessionTokenRecord | undefined,
  token: string | undefined,
  nowMs: number,
): boolean {
  return Boolean(record && token && record.token === token && !isTokenExpired(record, nowMs));
}
