import { defaultAgentConfig } from "@droid-webscr/config";

export function agentHealth() {
  return {
    host: defaultAgentConfig.host,
    port: defaultAgentConfig.port,
    status: "ok" as const,
  };
}
