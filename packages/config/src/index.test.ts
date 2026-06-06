import { describe, expect, it } from "vitest";
import { defaultAgentConfig } from "./index.js";

describe("config package skeleton", () => {
  it("defaults to local-only exposure", () => {
    expect(defaultAgentConfig).toEqual({
      host: "127.0.0.1",
      port: 7391,
    });
  });
});
