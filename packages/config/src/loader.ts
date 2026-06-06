import { ConfigError, validateAgentConfig } from "./schema.js";

export function loadAgentConfig(input: unknown) {
  const result = validateAgentConfig(input);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

export function configErrorMessage(error: unknown): string {
  if (error instanceof ConfigError) {
    return `${error.code}: ${error.message}`;
  }
  return "CONFIG_UNKNOWN: Unknown configuration error";
}
