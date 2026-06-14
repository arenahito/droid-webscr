import { SessionTokenRecord, isTokenExpired } from "./session-token.js";
import { AgentConfig } from "@droid-webscr/config";

export function validateSessionToken(
  record: SessionTokenRecord | undefined,
  token: string | undefined,
  nowMs: number,
): boolean {
  return Boolean(record && token && record.token === token && !isTokenExpired(record, nowMs));
}

export function validateAgentAuthHeader(
  authorization: string | string[] | undefined,
  config: AgentConfig,
): boolean {
  const values = Array.isArray(authorization) ? authorization : [authorization];
  return values.some((value) => value === `Bearer ${config.authToken}`);
}
