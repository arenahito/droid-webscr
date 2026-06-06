import { AgentConfig } from "@droid-webscr/config";

export function isAllowedOrigin(origin: string | undefined, config: AgentConfig): boolean {
  if (!origin) {
    return true;
  }
  try {
    const url = new URL(origin);
    return isAllowedHost(url.host, config);
  } catch {
    return false;
  }
}

export function isAllowedHost(host: string | undefined, config: AgentConfig): boolean {
  if (!host) {
    return false;
  }
  const normalized = host.split(":")[0];
  if (config.bindHost === "127.0.0.1") {
    return normalized === "127.0.0.1" || normalized === "localhost";
  }
  return normalized === config.bindHost || Boolean(config.authToken);
}
