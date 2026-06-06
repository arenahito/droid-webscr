import { loadAgentConfig } from "./config/load-agent-config.js";

export function loadCliConfig(input: unknown) {
  return loadAgentConfig(input);
}
