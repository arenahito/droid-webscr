import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpAgentClient } from "./agent-client.js";

describe("HTTP agent client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists devices and creates sessions through agent endpoints", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/devices")) {
        return jsonResponse({
          devices: [{ authorizationState: "authorized", serial: "emulator-5554" }],
        });
      }
      return jsonResponse({ serial: "emulator-5554", sessionId: "s1", token: "t1" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createHttpAgentClient("http://127.0.0.1:7391");

    await expect(client.listDevices()).resolves.toEqual([
      { authorizationState: "authorized", serial: "emulator-5554" },
    ]);
    await expect(client.createSession("emulator-5554")).resolves.toEqual({
      serial: "emulator-5554",
      sessionId: "s1",
      token: "t1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7391/api/sessions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws clear errors for failed agent responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503 })),
    );
    const client = createHttpAgentClient();

    await expect(client.listDevices()).rejects.toThrow("Device listing failed with HTTP 503");
    await expect(client.createSession("emulator-5554")).rejects.toThrow(
      "Session creation failed with HTTP 503",
    );
  });

  it("rejects non-json device responses from a frontend dev server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        headers: new Headers({ "content-type": "text/html" }),
        ok: true,
        status: 200,
      })),
    );
    const client = createHttpAgentClient();

    await expect(client.listDevices()).rejects.toThrow(
      "Agent API did not return a device JSON response",
    );
  });
});

function jsonResponse(body: unknown): Response {
  return {
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    ok: true,
    status: 200,
  } as Response;
}
