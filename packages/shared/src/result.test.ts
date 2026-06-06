import { describe, expect, it } from "vitest";
import { AppError, err, isErr, isOk, ok } from "./index.js";

describe("shared result and error primitives", () => {
  it("creates typed success and failure results", () => {
    const success = ok(42);
    const failure = err(new AppError("CONFIG_INVALID", "Invalid config"));

    expect(isOk(success)).toBe(true);
    expect(isErr(success)).toBe(false);
    expect(isErr(failure)).toBe(true);
    expect(isOk(failure)).toBe(false);

    if (success.ok) {
      expect(success.value).toBe(42);
    }
    if (!failure.ok) {
      expect(failure.error.code).toBe("CONFIG_INVALID");
      expect(failure.error.message).toBe("Invalid config");
    }
  });
});
