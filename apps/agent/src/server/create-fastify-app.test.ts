import { describe, expect, it } from "vitest";
import { FakeAdbProvider } from "@droid-webscr/adb";
import { AdbAuthorizationState, AdbTransportKind } from "@droid-webscr/adb";
import { AgentConfig } from "@droid-webscr/config";
import { createFrameHeader, encodeFrame, MessageType, StreamId } from "@droid-webscr/protocol";
import {
  createFastifyApp,
  createLoggerOptions,
  hasBinaryWebSocketProtocol,
  selectBinaryWebSocketProtocol,
} from "./create-fastify-app.js";
import { binaryWebSocketProtocol } from "./websocket.js";

describe("agent server", () => {
  it("configures structured logging with token redaction", () => {
    expect(createLoggerOptions(false)).toBe(false);
    expect(createLoggerOptions(undefined)).toEqual({
      level: "info",
      redact: ["req.headers.authorization", "req.query.token", "token", "*.token"],
    });
  });

  it("selects and validates the binary WebSocket subprotocol", () => {
    expect(selectBinaryWebSocketProtocol(new Set([binaryWebSocketProtocol]))).toBe(
      binaryWebSocketProtocol,
    );
    expect(selectBinaryWebSocketProtocol(new Set(["json"]))).toBe(false);
    expect(hasBinaryWebSocketProtocol(undefined)).toBe(false);
    expect(hasBinaryWebSocketProtocol(["json, droid-webscr.v1"])).toBe(true);
  });

  it("returns health without exposing secrets", async () => {
    const app = await createFastifyApp(testContext());
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", version: "0.0.0" });
    await app.close();
  });

  it("constructs the default device server boundary when none is supplied", async () => {
    const context = testContext();
    const app = await createFastifyApp({ ...context, deviceServer: undefined });

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("rejects non-local runtime bind without auth", async () => {
    await expect(
      createFastifyApp(
        testContext({
          authToken: undefined,
          bindHost: "0.0.0.0",
          clipboard: { enabled: false },
          port: 7391,
        }),
      ),
    ).rejects.toThrow("Non-local bind addresses require authToken.");

    const app = await createFastifyApp(
      testContext({
        authToken: "secret",
        bindHost: "0.0.0.0",
        clipboard: { enabled: false },
        port: 7391,
      }),
    );
    const response = await app.inject({ method: "GET", url: "/api/health" });
    const devicesWithoutAuth = await app.inject({ method: "GET", url: "/api/devices" });
    const createWithoutAuth = await app.inject({
      method: "POST",
      payload: { serial: "emulator-5554" },
      url: "/api/sessions",
    });
    const createWithAuth = await app.inject({
      headers: { authorization: "Bearer secret" },
      method: "POST",
      payload: { serial: "emulator-5554" },
      url: "/api/sessions",
    });

    expect(response.statusCode).toBe(200);
    expect(devicesWithoutAuth.statusCode).toBe(401);
    expect(createWithoutAuth.statusCode).toBe(401);
    expect(createWithAuth.statusCode).toBe(201);
    await app.close();
  });

  it("keeps origin checks independent from configured agent auth", async () => {
    const context = testContext({
      authToken: "secret",
      bindHost: "0.0.0.0",
      clipboard: { enabled: false },
      port: 7391,
    });
    const app = await createFastifyApp(context);
    const created = await app.inject({
      headers: { authorization: "Bearer secret" },
      method: "POST",
      payload: { serial: "emulator-5554" },
      url: "/api/sessions",
    });
    const session = created.json();

    await expect(
      app.injectWS(`/ws/session/${session.sessionId}?token=${session.token}`, {
        headers: {
          authorization: "Bearer secret",
          host: "192.168.1.20:7391",
          origin: "http://evil.example",
          "sec-websocket-protocol": binaryWebSocketProtocol,
        },
      }),
    ).rejects.toThrow("Unexpected server response: 403");
    await expect(
      app.injectWS(`/ws/session/${session.sessionId}?token=bad`, {
        headers: {
          host: "192.168.1.20:7391",
          origin: "http://192.168.1.20:7391",
          "sec-websocket-protocol": binaryWebSocketProtocol,
        },
      }),
    ).rejects.toThrow("Unexpected server response: 401");
    const ws = await app.injectWS(`/ws/session/${session.sessionId}?token=${session.token}`, {
      headers: {
        authorization: "Bearer secret",
        host: "192.168.1.20:7391",
        origin: "http://192.168.1.20:7391",
        "sec-websocket-protocol": binaryWebSocketProtocol,
      },
    });
    ws.terminate();

    await app.close();
  });

  it("lists devices through the ADB provider contract", async () => {
    const app = await createFastifyApp(testContext());

    const response = await app.inject({ method: "GET", url: "/api/devices" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      devices: [
        {
          authorizationState: "authorized",
          serial: "emulator-5554",
          transportKind: "emulator",
        },
      ],
    });
    await app.close();
  });

  it("exposes runtime config share URL and device lifecycle operations", async () => {
    const context = testContext({
      authToken: "secret",
      bindHost: "0.0.0.0",
      clipboard: { enabled: true },
      port: 7391,
    });
    const connectedEndpoints: string[] = [];
    const disconnectedSerials: string[] = [];
    const adbProvider = context.adbProvider as typeof context.adbProvider & {
      connectEndpoint(endpoint: string): Promise<void>;
      disconnect(serial: string): Promise<void>;
    };
    adbProvider.connectEndpoint = async (endpoint) => {
      connectedEndpoints.push(endpoint);
    };
    adbProvider.disconnect = async (serial) => {
      disconnectedSerials.push(serial);
    };
    const app = await createFastifyApp(context);
    const headers = { authorization: "Bearer secret" };

    await expect(app.inject({ headers, method: "GET", url: "/api/config" })).resolves.toMatchObject(
      {
        statusCode: 200,
      },
    );
    expect((await app.inject({ headers, method: "GET", url: "/api/config" })).json()).toEqual({
      bindHost: "0.0.0.0",
      clipboardEnabled: true,
      port: 7391,
    });
    expect((await app.inject({ headers, method: "GET", url: "/api/share-url" })).json()).toEqual({
      url: "http://127.0.0.1:7391",
    });
    expect(
      (
        await app.inject({
          headers,
          method: "PATCH",
          payload: { bindHost: "192.168.1.20", port: 7400 },
          url: "/api/config/bind",
        })
      ).json(),
    ).toEqual({
      bindHost: "192.168.1.20",
      clipboardEnabled: true,
      message: "Runtime bind updated; restart the agent to move the listening socket.",
      ok: true,
      port: 7400,
      shareUrl: "http://192.168.1.20:7400",
    });
    expect((await app.inject({ headers, method: "GET", url: "/api/config" })).json()).toEqual({
      bindHost: "192.168.1.20",
      clipboardEnabled: true,
      port: 7400,
    });
    expect(
      (
        await app.inject({
          headers,
          method: "PATCH",
          payload: { enabled: false },
          url: "/api/config/clipboard",
        })
      ).json(),
    ).toEqual({
      bindHost: "192.168.1.20",
      clipboardEnabled: false,
      message: "Clipboard sync disabled",
      ok: true,
      port: 7400,
    });
    expect((await app.inject({ headers, method: "GET", url: "/api/config" })).json()).toEqual({
      bindHost: "192.168.1.20",
      clipboardEnabled: false,
      port: 7400,
    });
    expect((await app.inject({ headers, method: "GET", url: "/api/share-url" })).json()).toEqual({
      url: "http://192.168.1.20:7400",
    });
    expect(
      (
        await app.inject({
          headers,
          method: "POST",
          payload: { endpoint: "192.168.1.40:5555" },
          url: "/api/devices/connect",
        })
      ).json(),
    ).toEqual({ message: "Endpoint 192.168.1.40:5555 connected", ok: true });
    expect(
      (
        await app.inject({
          headers,
          method: "POST",
          payload: { alias: "Pixel Lab" },
          url: "/api/devices/emulator-5554/rename",
        })
      ).json(),
    ).toEqual({ message: "Device emulator-5554 renamed", ok: true });
    expect(
      (await app.inject({ headers, method: "POST", url: "/api/devices/scan" })).json(),
    ).toEqual({
      devices: [
        {
          authorizationState: "authorized",
          model: "Pixel Lab",
          serial: "emulator-5554",
          transportKind: "emulator",
        },
      ],
    });
    expect(
      (
        await app.inject({
          headers,
          method: "POST",
          url: "/api/devices/emulator-5554/disconnect",
        })
      ).json(),
    ).toEqual({ message: "Device emulator-5554 disconnected", ok: true });
    expect(connectedEndpoints).toEqual(["192.168.1.40:5555"]);
    expect(disconnectedSerials).toEqual(["emulator-5554"]);
    await app.close();
  });

  it("normalizes share URLs for wildcard and IPv6 bind hosts", async () => {
    const wildcard = await createFastifyApp(
      testContext({
        authToken: "secret",
        bindHost: "0.0.0.0",
        clipboard: { enabled: false },
        port: 7391,
      }),
    );
    const ipv6 = await createFastifyApp(
      testContext({
        authToken: undefined,
        bindHost: "::1",
        clipboard: { enabled: false },
        port: 7391,
      }),
    );

    expect(
      (
        await wildcard.inject({
          headers: { authorization: "Bearer secret" },
          method: "GET",
          url: "/api/share-url",
        })
      ).json(),
    ).toEqual({ url: "http://127.0.0.1:7391" });
    expect((await ipv6.inject({ method: "GET", url: "/api/share-url" })).json()).toEqual({
      url: "http://[::1]:7391",
    });
    await wildcard.close();
    await ipv6.close();
  });

  it("rejects unsafe runtime bind updates without auth", async () => {
    const app = await createFastifyApp(testContext());

    const response = await app.inject({
      method: "PATCH",
      payload: { bindHost: "0.0.0.0", port: 7391 },
      url: "/api/config/bind",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Non-local bind addresses require authToken." });
    await app.close();
  });

  it("rejects invalid runtime clipboard updates", async () => {
    const app = await createFastifyApp(testContext());

    await expect(
      app.inject({
        method: "PATCH",
        payload: { enabled: "yes" },
        url: "/api/config/clipboard",
      }),
    ).resolves.toMatchObject({ statusCode: 400 });

    await app.close();
  });

  it("validates lifecycle operation payloads", async () => {
    const app = await createFastifyApp(testContext());

    expect(
      (await app.inject({ method: "POST", payload: {}, url: "/api/devices/connect" })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          payload: {},
          url: "/api/devices/emulator-5554/rename",
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });

  it("creates short-lived device-bound sessions", async () => {
    const app = await createFastifyApp(testContext());

    const response = await app.inject({
      method: "POST",
      payload: { serial: "emulator-5554" },
      url: "/api/sessions",
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      serial: "emulator-5554",
    });
    expect(response.json().sessionId).toEqual(expect.any(String));
    expect(response.json().token).toEqual(expect.any(String));
    await app.close();
  });

  it("rejects session creation without a serial", async () => {
    const app = await createFastifyApp(testContext());

    const response = await app.inject({
      method: "POST",
      payload: {},
      url: "/api/sessions",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "serial is required" });
    await app.close();
  });

  it("rejects unsafe origin host and invalid token combinations", async () => {
    const context = testContext();
    const app = await createFastifyApp(context);
    const created = await app.inject({
      method: "POST",
      payload: { serial: "emulator-5554" },
      url: "/api/sessions",
    });
    const session = created.json();

    await expect(
      app.injectWS(`/ws/session/${session.sessionId}?token=${session.token}`, {
        headers: {
          host: "127.0.0.1:7391",
          origin: "http://evil.example",
          "sec-websocket-protocol": binaryWebSocketProtocol,
        },
      }),
    ).rejects.toThrow("Unexpected server response: 403");

    await expect(
      app.injectWS(`/ws/session/${session.sessionId}?token=${session.token}`, {
        headers: {
          host: "evil.example",
          origin: "http://127.0.0.1:7391",
          "sec-websocket-protocol": binaryWebSocketProtocol,
        },
      }),
    ).rejects.toThrow("Unexpected server response: 403");

    await expect(
      app.injectWS(`/ws/session/${session.sessionId}?token=bad`, {
        headers: {
          host: "127.0.0.1:7391",
          origin: "http://127.0.0.1:7391",
          "sec-websocket-protocol": binaryWebSocketProtocol,
        },
      }),
    ).rejects.toThrow("Unexpected server response: 401");

    await expect(
      app.injectWS(`/ws/session/${session.sessionId}?token=${session.token}`, {
        headers: { host: "127.0.0.1:7391", origin: "http://127.0.0.1:7391" },
      }),
    ).rejects.toThrow("Unexpected server response: 426");

    await app.close();
  });

  it("bridges binary frames unchanged in both directions and stops the device session on disconnect", async () => {
    const context = testContext();
    const app = await createFastifyApp(context);
    const created = await app.inject({
      method: "POST",
      payload: { serial: "emulator-5554" },
      url: "/api/sessions",
    });
    const session = created.json();
    const ws = await app.injectWS(`/ws/session/${session.sessionId}?token=${session.token}`, {
      headers: {
        host: "127.0.0.1:7391",
        origin: "http://127.0.0.1:7391",
        "sec-websocket-protocol": binaryWebSocketProtocol,
      },
    });
    const frame = encodeFrame({
      header: createFrameHeader({
        sequence: 1n,
        streamId: StreamId.Control,
        type: MessageType.ControlText,
      }),
      payload: new Uint8Array([1, 2, 3]),
    });

    const fromDevice = new Promise<Buffer>((resolve) => {
      ws.once("message", (data: Buffer) => resolve(data));
    });
    ws.send(frame);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(context.deviceServer.writes.map((item) => [...item])).toEqual([[...frame]]);
    context.deviceServer.pushFromDevice(frame);
    expect([...new Uint8Array(await fromDevice)]).toEqual([...frame]);
    ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(context.deviceServer.stopCalls).toEqual(["emulator-5554"]);
    await app.close();
  });

  it("buffers browser frames sent while the device server is still starting", async () => {
    let releaseStart: (() => void) | undefined;
    const writes: Uint8Array[] = [];
    const context = testContext();
    const app = await createFastifyApp({
      ...context,
      deviceServer: {
        async start(serial) {
          await new Promise<void>((resolve) => {
            releaseStart = resolve;
          });
          return {
            frames: (async function* (): AsyncIterable<Uint8Array> {})(),
            serial,
            stop: async () => {},
            write: async (frame: Uint8Array) => {
              writes.push(frame);
            },
          };
        },
      },
    });
    const created = await app.inject({
      method: "POST",
      payload: { serial: "emulator-5554" },
      url: "/api/sessions",
    });
    const session = created.json();
    const ws = await app.injectWS(`/ws/session/${session.sessionId}?token=${session.token}`, {
      headers: {
        host: "127.0.0.1:7391",
        origin: "http://127.0.0.1:7391",
        "sec-websocket-protocol": binaryWebSocketProtocol,
      },
    });
    const frame = new Uint8Array([1, 2, 3]);

    ws.send(frame);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toEqual([]);
    releaseStart?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writes.map((item) => Array.from(item))).toEqual([Array.from(frame)]);
    ws.terminate();
    await app.close();
  });

  it("keeps the websocket open while waiting for device frames after startup", async () => {
    let releaseStart: (() => void) | undefined;
    let pushFrame: ((frame: Uint8Array) => void) | undefined;
    const context = testContext();
    const app = await createFastifyApp({
      ...context,
      deviceServer: {
        async start(serial) {
          await new Promise<void>((resolve) => {
            releaseStart = resolve;
          });
          return {
            frames: (async function* (): AsyncIterable<Uint8Array> {
              yield await new Promise<Uint8Array>((resolve) => {
                pushFrame = resolve;
              });
            })(),
            serial,
            stop: async () => {},
            write: async () => {},
          };
        },
      },
    });
    const created = await app.inject({
      method: "POST",
      payload: { serial: "emulator-5554" },
      url: "/api/sessions",
    });
    const session = created.json();
    const ws = await app.injectWS(`/ws/session/${session.sessionId}?token=${session.token}`, {
      headers: {
        host: "127.0.0.1:7391",
        origin: "http://127.0.0.1:7391",
        "sec-websocket-protocol": binaryWebSocketProtocol,
      },
    });
    const fromDevice = new Promise<Buffer>((resolve) => {
      ws.once("message", (data: Buffer) => resolve(data));
    });
    const frame = encodeFrame({
      header: createFrameHeader({
        sequence: 2n,
        streamId: StreamId.Control,
        type: MessageType.ControlText,
      }),
      payload: new Uint8Array([4, 5, 6]),
    });

    releaseStart?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ws.readyState).toBe(1);
    pushFrame?.(frame);
    expect([...new Uint8Array(await fromDevice)]).toEqual([...frame]);

    ws.terminate();
    await app.close();
  });

  it("rejects duplicate active browser connections but allows reconnect after close", async () => {
    const context = testContext();
    const app = await createFastifyApp(context);
    const created = await app.inject({
      method: "POST",
      payload: { serial: "emulator-5554" },
      url: "/api/sessions",
    });
    const session = created.json();
    const headers = {
      host: "127.0.0.1:7391",
      origin: "http://127.0.0.1:7391",
      "sec-websocket-protocol": binaryWebSocketProtocol,
    };
    const ws = await app.injectWS(`/ws/session/${session.sessionId}?token=${session.token}`, {
      headers,
    });

    await expect(
      app.injectWS(`/ws/session/${session.sessionId}?token=${session.token}`, { headers }),
    ).rejects.toThrow("Unexpected server response: 409");

    ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reconnected = await app.injectWS(
      `/ws/session/${session.sessionId}?token=${session.token}`,
      { headers },
    );
    reconnected.terminate();

    expect(context.deviceServer.startedSerials).toEqual(["emulator-5554", "emulator-5554"]);
    await app.close();
  });

  it("releases active browser session state when device start fails", async () => {
    const context = testContext();
    const startedSerials: string[] = [];
    const app = await createFastifyApp({
      ...context,
      deviceServer: {
        async start(serial) {
          startedSerials.push(serial);
          throw new Error("device start failed");
        },
      },
    });
    const created = await app.inject({
      method: "POST",
      payload: { serial: "emulator-5554" },
      url: "/api/sessions",
    });
    const session = created.json();
    const headers = {
      host: "127.0.0.1:7391",
      origin: "http://127.0.0.1:7391",
      "sec-websocket-protocol": binaryWebSocketProtocol,
    };

    const failed = await app.injectWS(`/ws/session/${session.sessionId}?token=${session.token}`, {
      headers,
    });
    await waitForWebSocketClose(failed);
    const retried = await app.injectWS(`/ws/session/${session.sessionId}?token=${session.token}`, {
      headers,
    });
    await waitForWebSocketClose(retried);

    expect(startedSerials).toEqual(["emulator-5554", "emulator-5554"]);

    await app.close();
  });
});

async function waitForWebSocketClose(ws: {
  once: (event: "close", listener: () => void) => void;
  readyState: number;
}) {
  if (ws.readyState === 3) {
    return;
  }
  await new Promise<void>((resolve) => {
    ws.once("close", resolve);
  });
}

function testContext(
  config: AgentConfig = {
    authToken: undefined,
    bindHost: "127.0.0.1",
    clipboard: { enabled: false },
    port: 7391,
  },
) {
  const adbProvider = new FakeAdbProvider([
    {
      authorizationState: AdbAuthorizationState.Authorized,
      serial: "emulator-5554",
      transportKind: AdbTransportKind.Emulator,
    },
  ]);
  const stopCalls: string[] = [];
  const writes: Uint8Array[] = [];
  const startedSerials: string[] = [];
  const deviceFrames: Uint8Array[] = [];
  let pendingDeviceFrame: (() => void) | undefined;
  const nextDeviceFrame = async () => {
    if (deviceFrames.length === 0) {
      await new Promise<void>((resolve) => {
        pendingDeviceFrame = resolve;
      });
      pendingDeviceFrame = undefined;
    }
    return deviceFrames.shift() ?? new Uint8Array();
  };
  return {
    adbProvider,
    config,
    deviceServer: {
      startedSerials,
      stopCalls,
      writes,
      pushFromDevice(frame: Uint8Array) {
        deviceFrames.push(frame);
        pendingDeviceFrame?.();
      },
      async start(serial: string) {
        startedSerials.push(serial);
        return {
          frames: (async function* (): AsyncIterable<Uint8Array> {
            yield await nextDeviceFrame();
          })(),
          serial,
          stop: async () => {
            stopCalls.push(serial);
          },
          write: async (frame: Uint8Array) => {
            writes.push(frame);
          },
        };
      },
    },
    logger: false,
  };
}
