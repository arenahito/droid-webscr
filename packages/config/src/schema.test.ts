import { describe, expect, it } from "vitest";
import { ConfigError, configErrorMessage, loadAgentConfig, validateAgentConfig } from "./index.js";

describe("agent config schema", () => {
  it("uses safe local defaults with clipboard disabled", () => {
    expect(loadAgentConfig({})).toEqual({
      authToken: undefined,
      bindHost: "127.0.0.1",
      clipboard: { enabled: false },
      port: 7391,
    });
  });

  it("rejects unauthenticated non-local binds", () => {
    const result = validateAgentConfig({ bindHost: "0.0.0.0" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_UNSAFE_BIND");
    }
  });

  it("accepts non-local binds only when auth is configured", () => {
    expect(loadAgentConfig({ authToken: "secret", bindHost: "0.0.0.0" })).toEqual({
      authToken: "secret",
      bindHost: "0.0.0.0",
      clipboard: { enabled: false },
      port: 7391,
    });
  });

  it("reports invalid config and load errors deterministically", () => {
    const invalid = validateAgentConfig({ port: 99_999 });

    expect(invalid.ok).toBe(false);
    expect(() => loadAgentConfig({ port: 99_999 })).toThrow(ConfigError);
    if (!invalid.ok) {
      expect(configErrorMessage(invalid.error)).toContain("CONFIG_INVALID");
    }
    expect(configErrorMessage("nope")).toBe("CONFIG_UNKNOWN: Unknown configuration error");
  });
});
