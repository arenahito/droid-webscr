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
    if (url.protocol !== "http:") {
      return false;
    }
    if (!isAllowedHost(url.host, config)) {
      if (!(requestHost && config.authToken && isLocalHost(url.host))) {
        return false;
      }
    }
    if (requestHost && config.authToken && isLocalHost(url.host)) {
      return true;
    }
    return requestHost ? sameEndpoint(url, requestHost) : true;
  } catch {
    return false;
  }
}

export function isAllowedHost(host: string | undefined, config: AgentConfig): boolean {
  if (!host) {
    return false;
  }
  const normalized = normalizeHost(host);
  if (
    config.bindHost === "127.0.0.1" ||
    config.bindHost === "localhost" ||
    config.bindHost === "::1"
  ) {
    return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
  }
  if (config.bindHost === "0.0.0.0" || config.bindHost === "::") {
    return normalized.length > 0;
  }
  return normalized === config.bindHost;
}

function normalizeHost(host: string): string {
  const normalized = host.toLowerCase();
  if (normalized.startsWith("[")) {
    return normalized.slice(1, normalized.indexOf("]"));
  }
  const firstColon = normalized.indexOf(":");
  if (firstColon === -1) {
    return normalized;
  }
  if (firstColon === normalized.lastIndexOf(":")) {
    return normalized.slice(0, firstColon);
  }
  return normalized;
}

function isLocalHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function samePort(url: URL, host: string): boolean {
  return (
    (url.port || defaultPort(url.protocol)) === (extractPort(host) || defaultPort(url.protocol))
  );
}

function sameEndpoint(url: URL, host: string): boolean {
  return normalizeHost(url.host) === normalizeHost(host) && samePort(url, host);
}

function defaultPort(protocol: string): string {
  /* v8 ignore next -- supported callers pass http: in local agent URLs. */
  return protocol === "https:" ? "443" : "80";
}

function extractPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return host.slice(end + 1).replace(/^:/, "");
  }
  const parts = host.split(":");
  /* v8 ignore next -- host parsing is exercised with either one part or a valid host:port pair. */
  return parts.length === 2 ? (parts[1] ?? "") : "";
}
