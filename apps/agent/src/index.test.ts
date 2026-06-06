import { describe, expect, it } from "vitest";
import { agentHealth } from "./index.js";

describe("agent app skeleton", () => {
  it("starts from secure local defaults", () => {
    expect(agentHealth()).toEqual({
      host: "127.0.0.1",
      port: 7391,
      status: "ok",
    });
  });
});
