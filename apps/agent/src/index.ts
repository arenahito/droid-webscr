import { defaultAgentConfig } from "@droid-webscr/config";

export function agentHealth() {
  return {
    host: defaultAgentConfig.bindHost,
    port: defaultAgentConfig.port,
    status: "ok" as const,
  };
}
