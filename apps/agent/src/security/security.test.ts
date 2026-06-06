import { describe, expect, it } from "vitest";
import { isAllowedHost, isAllowedOrigin } from "./origin.js";
import { createSessionToken, isTokenExpired } from "./session-token.js";
import { validateSessionToken } from "./auth.js";

const localConfig = {
  authToken: undefined,
  bindHost: "127.0.0.1",
  clipboard: { enabled: false },
  port: 7391,
};

describe("agent security helpers", () => {
  it("handles invalid origins and host policy branches", () => {
    expect(isAllowedOrigin(undefined, localConfig)).toBe(true);
    expect(isAllowedOrigin("not a url", localConfig)).toBe(false);
    expect(isAllowedHost(undefined, localConfig)).toBe(false);
    expect(isAllowedHost("localhost:7391", localConfig)).toBe(true);
    expect(isAllowedHost("evil.example", localConfig)).toBe(false);
    expect(
      isAllowedHost("0.0.0.0:7391", {
        ...localConfig,
        authToken: "secret",
        bindHost: "0.0.0.0",
      }),
    ).toBe(true);
    expect(
      isAllowedHost("other.example", {
        ...localConfig,
        authToken: undefined,
        bindHost: "0.0.0.0",
      }),
    ).toBe(false);
  });

  it("validates token expiry and token matching", () => {
    const record = createSessionToken("session", "serial", 100, 10);

    expect(isTokenExpired(record, 109)).toBe(false);
    expect(isTokenExpired(record, 110)).toBe(true);
    expect(validateSessionToken(record, record.token, 109)).toBe(true);
    expect(validateSessionToken(record, "bad", 109)).toBe(false);
    expect(validateSessionToken(undefined, record.token, 109)).toBe(false);
    expect(validateSessionToken(record, record.token, 110)).toBe(false);
  });
});
