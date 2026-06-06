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

  it("calls device lifecycle runtime and share endpoints", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/config")) {
        return jsonResponse({ bindHost: "127.0.0.1", clipboardEnabled: true, port: 7391 });
      }
      if (url.endsWith("/api/share-url")) {
        return jsonResponse({ url: "http://127.0.0.1:7391" });
      }
      if (url.endsWith("/api/devices/scan")) {
        return jsonResponse({
          devices: [{ authorizationState: "authorized", serial: "emulator-5554" }],
        });
      }
      return jsonResponse({ message: "ok", ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createHttpAgentClient("http://127.0.0.1:7391");

    await expect(client.getRuntimeConfig?.()).resolves.toEqual({
      bindHost: "127.0.0.1",
      clipboardEnabled: true,
      port: 7391,
    });
    await expect(client.shareUrl?.()).resolves.toEqual({ url: "http://127.0.0.1:7391" });
    await expect(client.scanDevices?.()).resolves.toEqual([
      { authorizationState: "authorized", serial: "emulator-5554" },
    ]);
    await expect(client.connectEndpoint?.("192.168.1.40:5555")).resolves.toEqual({
      message: "ok",
      ok: true,
    });
    await expect(client.renameDevice?.("emulator-5554", "Pixel Lab")).resolves.toEqual({
      message: "ok",
      ok: true,
    });
    await expect(client.disconnectDevice?.("emulator-5554")).resolves.toEqual({
      message: "ok",
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7391/api/devices/emulator-5554/rename",
      expect.objectContaining({
        body: JSON.stringify({ alias: "Pixel Lab" }),
        method: "POST",
      }),
    );
  });

  it("sends bearer auth when configured for non-local agents", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/devices")) {
        return jsonResponse({ devices: [] });
      }
      return jsonResponse({ serial: "emulator-5554", sessionId: "s1", token: "t1" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createHttpAgentClient({
      authToken: "secret",
      baseUrl: "http://192.168.1.20:7391",
    });

    await client.listDevices();
    await client.createSession("emulator-5554");

    expect(fetchMock).toHaveBeenCalledWith("http://192.168.1.20:7391/api/devices", {
      headers: { authorization: "Bearer secret" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.1.20:7391/api/sessions",
      expect.objectContaining({
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
      }),
    );
  });

  it("supports authenticated same-origin agent requests", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ devices: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createHttpAgentClient({ authToken: "secret" });

    await client.listDevices();

    expect(fetchMock).toHaveBeenCalledWith("/api/devices", {
      headers: { authorization: "Bearer secret" },
    });
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
