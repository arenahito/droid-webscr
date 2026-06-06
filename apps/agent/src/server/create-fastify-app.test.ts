import { describe, expect, it } from "vitest";
import { FakeAdbProvider } from "@droid-webscr/adb";
import { AdbAuthorizationState, AdbTransportKind } from "@droid-webscr/adb";
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
});

function testContext() {
  const adbProvider = new FakeAdbProvider([
    {
      authorizationState: AdbAuthorizationState.Authorized,
      serial: "emulator-5554",
      transportKind: AdbTransportKind.Emulator,
    },
  ]);
  const stopCalls: string[] = [];
  const writes: Uint8Array[] = [];
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
    config: {
      authToken: undefined,
      bindHost: "127.0.0.1",
      clipboard: { enabled: false },
      port: 7391,
    },
    deviceServer: {
      stopCalls,
      writes,
      pushFromDevice(frame: Uint8Array) {
        deviceFrames.push(frame);
        pendingDeviceFrame?.();
      },
      async start(serial: string) {
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
