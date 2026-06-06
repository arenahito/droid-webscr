import { AgentConfig } from "@droid-webscr/config";

export function isAllowedOrigin(
  origin: string | undefined,
  config: AgentConfig,
  requestHost?: string | undefined,
): boolean {
  if (!origin) {
    return true;
  }
  try {
    const url = new URL(origin);
    if (!isAllowedHost(url.host, config)) {
      return false;
    }
    return requestHost ? normalizeHost(url.host) === normalizeHost(requestHost) : true;
  } catch {
    return false;
  }
}

export function isAllowedHost(host: string | undefined, config: AgentConfig): boolean {
  if (!host) {
    return false;
  }
  const normalized = normalizeHost(host);
  if (config.bindHost === "127.0.0.1") {
    return normalized === "127.0.0.1" || normalized === "localhost";
  }
  if (config.bindHost === "0.0.0.0" || config.bindHost === "::") {
    return normalized.length > 0;
  }
  return normalized === config.bindHost;
}

function normalizeHost(host: string): string {
  return host.split(":")[0]!.toLowerCase();
}
