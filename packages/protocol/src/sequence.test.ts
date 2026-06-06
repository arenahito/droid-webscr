import { describe, expect, it } from "vitest";
import { compareSequence, isNextSequence } from "./sequence.js";

describe("sequence validation helpers", () => {
  it("detects the next expected sequence value", () => {
    expect(isNextSequence(10n, 11n)).toBe(true);
    expect(isNextSequence(10n, 12n)).toBe(false);
  });

  it("compares sequence values without losing bigint precision", () => {
    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);

    expect(compareSequence(maxSafe + 2n, maxSafe + 1n)).toBe(1);
    expect(compareSequence(maxSafe + 1n, maxSafe + 2n)).toBe(-1);
    expect(compareSequence(maxSafe + 1n, maxSafe + 1n)).toBe(0);
  });
});
