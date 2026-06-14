import { describe, expect, it } from "vitest";
import { FakeAdbProvider } from "@droid-webscr/adb";
import { AdbAuthorizationState, AdbTransportKind } from "@droid-webscr/adb";
import { AgentConfig } from "@droid-webscr/config";
import { createFrameHeader, encodeFrame, MessageType, StreamId } from "@droid-webscr/protocol";
import {
  createFastifyApp as createBaseFastifyApp,
  createLoggerOptions,
  hasBinaryWebSocketProtocol,
  selectBinaryWebSocketProtocol,
} from "./create-fastify-app.js";
import { binaryWebSocketProtocol } from "./websocket.js";

const agentAuthHeader = { authorization: "Bearer secret" };

async function createFastifyApp(...args: Parameters<typeof createBaseFastifyApp>) {
  const app = await createBaseFastifyApp(...args);
  const inject = app.inject.bind(app);
  app.inject = ((options, callback) => {
    if (typeof options === "string") {
      return inject(options, callback);
    }
    const headers = options.headers ?? {};
    const hasAuthorization = Object.keys(headers).some(
      (name) => name.toLowerCase() === "authorization",
    );
    const shouldAuthorize =
      typeof options.url === "string" &&
      options.url.startsWith("/api/") &&
      options.url !== "/api/health";
    const nextOptions =
      shouldAuthorize && !hasAuthorization
        ? { ...options, headers: { ...headers, ...agentAuthHeader } }
        : options;
    return inject(nextOptions, callback);
  }) as typeof app.inject;

  const injectWS = app.injectWS.bind(app);
  app.injectWS = ((url, options) => {
    const headers = options?.headers ?? {};
    const hasAuthorization = Object.keys(headers).some(
      (name) => name.toLowerCase() === "authorization",
    );
    return injectWS(url, {
      ...options,
      headers: hasAuthorization ? headers : { ...headers, ...agentAuthHeader },
    });
  }) as typeof app.injectWS;

  return app;
}

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

  it("serves packaged web assets without taking over API routes", async () => {
    const app = await createFastifyApp({
      ...testContext(),
      webUi: {
        staticFiles: {
          "/": { content: '<!doctype html><div id="root"></div>', contentType: "text/html" },
          "/assets/app.js": {
            content: "console.log('droid-webscr')",
            contentType: "text/javascript",
          },
        },
      },
    });

    const index = await app.inject({ method: "GET", url: "/" });
    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    const fallback = await app.inject({ method: "GET", url: "/devices/emulator-5554" });
    const api = await app.inject({ method: "GET", url: "/api/health" });
    const missingApi = await app.inject({ method: "GET", url: "/api/missing" });

    expect(index.statusCode).toBe(200);
    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.body).toContain('<div id="root"></div>');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect(asset.body).toContain("droid-webscr");
    expect(fallback.statusCode).toBe(200);
    expect(fallback.body).toContain('<div id="root"></div>');
    expect(api.statusCode).toBe(200);
    expect(missingApi.statusCode).toBe(404);
    await app.close();
  });

  it("keeps packaged web UI local even when the agent API is bound publicly", async () => {
    const app = await createFastifyApp({
      ...testContext({
        authToken: "secret",
        bindHost: "0.0.0.0",
        clipboard: { enabled: false },
        port: 7391,
      }),
      webUi: {
        staticFiles: {
          "/": { content: "<!doctype html><main>local ui</main>", contentType: "text/html" },
        },
      },
    });

    const localUi = await app.inject({
      method: "GET",
      remoteAddress: "127.0.0.1",
      url: "/",
    });
    const remoteUi = await app.inject({
      method: "GET",
      remoteAddress: "192.168.1.44",
      url: "/",
    });
    const remoteApi = await app.inject({
      headers: { authorization: "Bearer secret" },
      method: "GET",
      remoteAddress: "192.168.1.44",
      url: "/api/devices",
    });

    expect(localUi.statusCode).toBe(200);
    expect(remoteUi.statusCode).toBe(404);
    expect(remoteApi.statusCode).toBe(200);
    await app.close();
  });

  it("delegates development web requests to middleware on the unified server", async () => {
    const seenUrls: string[] = [];
    const app = await createFastifyApp({
      ...testContext(),
      webUi: {
        devMiddleware: async (request, response, next) => {
          seenUrls.push(request.url ?? "");
          if (request.url === "/src/main.tsx") {
            response.statusCode = 200;
            response.setHeader("content-type", "text/javascript");
            response.end("export default 'hmr'");
            return;
          }
          next();
        },
        renderIndex: async (url) => `<!doctype html><title>${url}</title>`,
      },
    });

    const moduleResponse = await app.inject({ method: "GET", url: "/src/main.tsx" });
    const indexResponse = await app.inject({ method: "GET", url: "/" });
    const apiResponse = await app.inject({ method: "GET", url: "/api/health" });

    expect(moduleResponse.statusCode).toBe(200);
    expect(moduleResponse.body).toContain("hmr");
    expect(indexResponse.statusCode).toBe(200);
    expect(indexResponse.body).toContain("<title>/</title>");
    expect(apiResponse.statusCode).toBe(200);
    expect(seenUrls).toContain("/src/main.tsx");
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
    const devicesWithoutAuth = await app.inject({
      headers: { authorization: "" },
      method: "GET",
      url: "/api/devices",
    });
    const createWithoutAuth = await app.inject({
      headers: { authorization: "" },
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

  it("uses the runtime bind config for websocket host and origin checks", async () => {
    const context = testContext({
      authToken: "secret",
      bindHost: "127.0.0.1",
      clipboard: { enabled: false },
      port: 7391,
    });
    const app = await createFastifyApp(context);
    const headers = { authorization: "Bearer secret" };

    await app.inject({
      headers,
      method: "PATCH",
      payload: { bindHost: "192.168.1.20", port: 7400 },
      url: "/api/config/bind",
    });
    const created = await app.inject({
      headers,
      method: "POST",
      payload: { serial: "emulator-5554" },
      url: "/api/sessions",
    });
    const session = created.json();

    const ws = await app.injectWS(`/ws/session/${session.sessionId}?token=${session.token}`, {
      headers: {
        authorization: "Bearer secret",
        host: "192.168.1.20:7400",
        origin: "http://192.168.1.20:7400",
        "sec-websocket-protocol": binaryWebSocketProtocol,
      },
    });
    ws.terminate();

    await app.close();
  });

  it("allows the same local web UI origin to reach the current runtime host", async () => {
    const context = testContext({
      authToken: "secret",
      bindHost: "127.0.0.1",
      clipboard: { enabled: false },
      port: 7391,
    });
    const app = await createFastifyApp(context);
    const headers = { authorization: "Bearer secret" };
    const response = await app.inject({
      headers: {
        ...headers,
        host: "127.0.0.1:7391",
        origin: "http://127.0.0.1:7391",
      },
      method: "GET",
      url: "/api/devices",
    });
    const created = await app.inject({
      headers,
      method: "POST",
      payload: { serial: "emulator-5554" },
      url: "/api/sessions",
    });
    const session = created.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:7391");
    const ws = await app.injectWS(`/ws/session/${session.sessionId}?token=${session.token}`, {
      headers: {
        authorization: "Bearer secret",
        host: "127.0.0.1:7391",
        origin: "http://127.0.0.1:7391",
        "sec-websocket-protocol": binaryWebSocketProtocol,
      },
    });
    ws.terminate();

    await app.close();
  });

  it("allows token-protected local web UI origins on alternate loopback ports", async () => {
    const app = await createFastifyApp(testContext());

    const preflight = await app.inject({
      headers: {
        host: "127.0.0.1:7391",
        origin: "http://127.0.0.1:7391",
      },
      method: "OPTIONS",
      url: "/api/devices",
    });
    const response = await app.inject({
      headers: {
        host: "127.0.0.1:7391",
        origin: "http://localhost:5174",
      },
      method: "GET",
      url: "/api/devices",
    });

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-methods"]).toBe("GET, POST, PATCH, OPTIONS");
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5174");
    const sameHostDifferentPort = await app.inject({
      headers: {
        host: "127.0.0.1:7391",
        origin: "http://127.0.0.1:5174",
      },
      method: "GET",
      url: "/api/devices",
    });
    expect(sameHostDifferentPort.statusCode).toBe(200);
    expect(sameHostDifferentPort.headers["access-control-allow-origin"]).toBe(
      "http://127.0.0.1:5174",
    );
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
      readDeviceLogs(serial: string, lines: number): Promise<readonly string[]>;
    };
    adbProvider.connectEndpoint = async (endpoint) => {
      connectedEndpoints.push(endpoint);
    };
    adbProvider.disconnect = async (serial) => {
      disconnectedSerials.push(serial);
    };
    adbProvider.readDeviceLogs = async (serial, lines) => [
      `${serial} requested ${lines} lines`,
      "06-09 13:40:01.000 I ActivityTaskManager: Displayed app",
    ];
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
      message: "Agent is now listening on 192.168.1.20:7400.",
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
          method: "GET",
          url: "/api/devices/emulator-5554/logs?lines=2",
        })
      ).json(),
    ).toEqual({
      lines: [
        "emulator-5554 requested 2 lines",
        "06-09 13:40:01.000 I ActivityTaskManager: Displayed app",
      ],
      ok: true,
      serial: "emulator-5554",
    });
    expect(
      (await app.inject({ headers, method: "POST", url: "/api/devices/scan" })).json(),
    ).toEqual({
      devices: [
        {
          authorizationState: "authorized",
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

  it("streams device log tail as SSE without reading history", async () => {
    const context = testContext({
      authToken: "secret",
      bindHost: "127.0.0.1",
      clipboard: { enabled: false },
      port: 7391,
    });
    const adbProvider = context.adbProvider;
    let historyReads = 0;
    adbProvider.readDeviceLogs = async () => {
      historyReads += 1;
      return ["history should not be read"];
    };
    const app = await createFastifyApp(context);
    const responsePromise = app.inject({
      headers: {
        authorization: "Bearer secret",
        host: "127.0.0.1:7391",
        origin: "http://127.0.0.1:7391",
      },
      method: "GET",
      url: "/api/devices/emulator-5554/logs/tail",
    });

    await waitForCondition(() => adbProvider.activeLogTails("emulator-5554").length > 0);
    adbProvider.appendDeviceLog("emulator-5554", "tail line 1");
    adbProvider.appendDeviceLog("emulator-5554", "tail line 2");
    await Promise.all(
      adbProvider.activeLogTails("emulator-5554").map((activeTail) => activeTail.close()),
    );

    const response = await responsePromise;

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:7391");
    expect(response.body).toContain("data: tail line 1\n\n");
    expect(response.body).toContain("data: tail line 2\n\n");
    expect(historyReads).toBe(0);
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
        authToken: "secret",
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
    expect(
      (
        await ipv6.inject({
          headers: { authorization: "Bearer secret" },
          method: "GET",
          url: "/api/share-url",
        })
      ).json(),
    ).toEqual({ url: "http://[::1]:7391" });
    await wildcard.close();
    await ipv6.close();
  });

  it("rejects runtime bind updates without bearer auth", async () => {
    const app = await createFastifyApp(testContext());

    const response = await app.inject({
      headers: { authorization: "" },
      method: "PATCH",
      payload: { bindHost: "0.0.0.0", port: 7391 },
      url: "/api/config/bind",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid agent auth token" });
    await app.close();
  });

  it("applies bind address changes on the current port", async () => {
    const app = await createFastifyApp(
      testContext({
        authToken: "secret",
        bindHost: "127.0.0.1",
        clipboard: { enabled: false },
        port: 7391,
      }),
    );

    const response = await app.inject({
      headers: { authorization: "Bearer secret" },
      method: "PATCH",
      payload: { bindHost: "192.168.1.20", port: 7391 },
      url: "/api/config/bind",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      bindHost: "192.168.1.20",
      ok: true,
      port: 7391,
    });
    expect(
      (
        await app.inject({
          headers: { authorization: "Bearer secret" },
          method: "GET",
          url: "/api/config",
        })
      ).json(),
    ).toEqual({
      bindHost: "192.168.1.20",
      clipboardEnabled: false,
      port: 7391,
    });
    await app.close();
  });

  it("accepts IPv6 loopback hosts in runtime origin checks", async () => {
    const app = await createFastifyApp(
      testContext({
        authToken: "secret",
        bindHost: "::1",
        clipboard: { enabled: false },
        port: 7391,
      }),
    );
    const response = await app.inject({
      headers: {
        host: "[::1]:7391",
        origin: "http://[::1]:7391",
      },
      method: "GET",
      url: "/api/devices",
    });
    const created = await app.inject({
      method: "POST",
      payload: { serial: "emulator-5554" },
      url: "/api/sessions",
    });
    const session = created.json();

    expect(response.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          headers: {
            host: "localhost:7391",
            origin: "http://localhost:7391",
          },
          method: "GET",
          url: "/api/devices",
        })
      ).statusCode,
    ).toBe(200);
    const ws = await app.injectWS(`/ws/session/${session.sessionId}?token=${session.token}`, {
      headers: {
        host: "[::1]:7391",
        origin: "http://[::1]:7391",
        "sec-websocket-protocol": binaryWebSocketProtocol,
      },
    });
    ws.terminate();
    await app.close();
  });

  it("accepts loopback host aliases when bound to localhost", async () => {
    const app = await createFastifyApp(
      testContext({
        authToken: "secret",
        bindHost: "localhost",
        clipboard: { enabled: false },
        port: 7391,
      }),
    );

    expect(
      (
        await app.inject({
          headers: {
            host: "127.0.0.1:7391",
            origin: "http://127.0.0.1:7391",
          },
          method: "GET",
          url: "/api/devices",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          headers: {
            host: "[::1]:7391",
            origin: "http://[::1]:7391",
          },
          method: "GET",
          url: "/api/devices",
        })
      ).statusCode,
    ).toBe(200);
    await app.close();
  });

  it("accepts default-port same-origin hosts without explicit ports", async () => {
    const app = await createFastifyApp(
      testContext({
        authToken: "secret",
        bindHost: "localhost",
        clipboard: { enabled: false },
        port: 80,
      }),
    );

    const response = await app.inject({
      headers: {
        host: "localhost",
        origin: "http://localhost",
      },
      method: "GET",
      url: "/api/devices",
    });

    expect(response.statusCode).toBe(200);
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

  it("requires bearer auth on protected HTTP routes when configured", async () => {
    const app = await createFastifyApp(
      testContext({
        authToken: "secret",
        bindHost: "127.0.0.1",
        clipboard: { enabled: false },
        port: 7391,
      }),
    );
    const cases: Array<{
      readonly method: "GET" | "PATCH" | "POST";
      readonly payload?: Record<string, boolean | number | string>;
      readonly url: string;
    }> = [
      { method: "GET", url: "/api/config" },
      { method: "GET", url: "/api/share-url" },
      { method: "PATCH", payload: { bindHost: "127.0.0.1", port: 7391 }, url: "/api/config/bind" },
      { method: "PATCH", payload: { enabled: true }, url: "/api/config/clipboard" },
      { method: "GET", url: "/api/devices" },
      { method: "POST", url: "/api/devices/scan" },
      { method: "POST", payload: { endpoint: "192.168.1.40:5555" }, url: "/api/devices/connect" },
      {
        method: "POST",
        payload: { direction: "right" },
        url: "/api/devices/emulator-5554/rotation",
      },
      { method: "GET", url: "/api/devices/emulator-5554/logs" },
      { method: "GET", url: "/api/devices/emulator-5554/logs/tail" },
      { method: "POST", url: "/api/devices/emulator-5554/disconnect" },
      { method: "POST", payload: { serial: "emulator-5554" }, url: "/api/sessions" },
    ];

    for (const item of cases) {
      const options =
        item.payload === undefined
          ? { headers: { authorization: "" }, method: item.method, url: item.url }
          : {
              headers: { authorization: "" },
              method: item.method,
              payload: item.payload,
              url: item.url,
            };
      // oxlint-disable-next-line no-await-in-loop -- each protected route is checked independently.
      const response = await app.inject(options);
      expect(response.statusCode, item.url).toBe(401);
      expect(response.json()).toEqual({ error: "Invalid agent auth token" });
    }

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
          method: "GET",
          url: "/api/devices/emulator-5554/logs?lines=0",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/devices/emulator-5554/logs?lines=1001",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          payload: {},
          url: "/api/config/bind",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          payload: { bindHost: "127.0.0.1", port: -1 },
          url: "/api/config/bind",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          payload: { direction: "upside-down" },
          url: "/api/devices/emulator-5554/rotation",
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });

  it("rotates devices and restores the saved Android rotation settings", async () => {
    const context = testContext();
    const commands: string[][] = [];
    let closeCalls = 0;
    const adbProvider = {
      ...context.adbProvider,
      connect: async (serial: string) => ({
        close: async () => {
          closeCalls += 1;
        },
        openSocket: async (name: string) => {
          const session = await context.adbProvider.connect(serial);
          return session.openSocket(name);
        },
        push: async () => {},
        serial,
        shell: async (command: readonly string[]) => {
          commands.push([...command]);
          return {
            command,
            exit: Promise.resolve(0),
            stderr: emptyByteStream(),
            stdout: singleChunkStream(savedRotationShellOutput(command)),
          };
        },
      }),
      listDevices: () => context.adbProvider.listDevices(),
      readDeviceLogs: (serial: string, lines: number) =>
        context.adbProvider.readDeviceLogs(serial, lines),
      tailDeviceLogs: (serial: string) => context.adbProvider.tailDeviceLogs(serial),
    };
    const app = await createFastifyApp({ ...context, adbProvider });

    const left = await app.inject({
      method: "POST",
      payload: { direction: "left" },
      url: "/api/devices/emulator-5554/rotation",
    });
    const reset = await app.inject({
      method: "POST",
      payload: { mode: "reset" },
      url: "/api/devices/emulator-5554/rotation",
    });

    expect(left.json()).toEqual({ message: "Device emulator-5554 rotated left", ok: true });
    expect(reset.json()).toEqual({ message: "Device emulator-5554 rotation reset", ok: true });
    expect(commands).toEqual([
      ["cmd", "window", "fixed-to-user-rotation"],
      ["cmd", "window", "get-ignore-orientation-request"],
      ["cmd", "window", "user-rotation"],
      ["cmd", "window", "user-rotation"],
      ["cmd", "window", "fixed-to-user-rotation", "enabled"],
      ["cmd", "window", "set-ignore-orientation-request", "true"],
      ["cmd", "window", "user-rotation", "lock", "1"],
      ["cmd", "window", "user-rotation", "lock", "2"],
      ["cmd", "window", "fixed-to-user-rotation", "enabled"],
      ["cmd", "window", "set-ignore-orientation-request", "false"],
    ]);
    expect(closeCalls).toBe(2);
    await app.close();
  });

  it("restores unlocked Android rotation settings from alternate shell output", async () => {
    const context = testContext();
    const commands: string[][] = [];
    const adbProvider = {
      ...context.adbProvider,
      connect: async (serial: string) => ({
        close: async () => {},
        openSocket: async (name: string) => {
          const session = await context.adbProvider.connect(serial);
          return session.openSocket(name);
        },
        push: async () => {},
        serial,
        shell: async (command: readonly string[]) => {
          commands.push([...command]);
          return {
            command,
            exit: Promise.resolve(0),
            stderr: emptyByteStream(),
            stdout: singleChunkStream(unlockedRotationShellOutput(command)),
          };
        },
      }),
      listDevices: () => context.adbProvider.listDevices(),
      readDeviceLogs: (serial: string, lines: number) =>
        context.adbProvider.readDeviceLogs(serial, lines),
      tailDeviceLogs: (serial: string) => context.adbProvider.tailDeviceLogs(serial),
    };
    const app = await createFastifyApp({ ...context, adbProvider });

    await app.inject({
      method: "POST",
      payload: { direction: "right" },
      url: "/api/devices/emulator-5554/rotation",
    });
    await app.inject({
      method: "POST",
      payload: { mode: "reset" },
      url: "/api/devices/emulator-5554/rotation",
    });

    expect(commands).toEqual([
      ["cmd", "window", "fixed-to-user-rotation"],
      ["cmd", "window", "get-ignore-orientation-request"],
      ["cmd", "window", "user-rotation"],
      ["cmd", "window", "user-rotation"],
      ["dumpsys", "display"],
      ["cmd", "window", "fixed-to-user-rotation", "enabled"],
      ["cmd", "window", "set-ignore-orientation-request", "true"],
      ["cmd", "window", "user-rotation", "lock", "0"],
      ["cmd", "window", "user-rotation", "free"],
      ["cmd", "window", "fixed-to-user-rotation", "disabled"],
      ["cmd", "window", "set-ignore-orientation-request", "true"],
    ]);
    await app.close();
  });

  it("falls back to default rotation restore values for unknown shell output", async () => {
    const context = testContext();
    const commands: string[][] = [];
    const adbProvider = {
      ...context.adbProvider,
      connect: async (serial: string) => ({
        close: async () => {},
        openSocket: async (name: string) => {
          const session = await context.adbProvider.connect(serial);
          return session.openSocket(name);
        },
        push: async () => {},
        serial,
        shell: async (command: readonly string[]) => {
          commands.push([...command]);
          return {
            command,
            exit: Promise.resolve(0),
            stderr: emptyByteStream(),
            stdout: singleChunkStream(unknownRotationShellOutput(command)),
          };
        },
      }),
      listDevices: () => context.adbProvider.listDevices(),
      readDeviceLogs: (serial: string, lines: number) =>
        context.adbProvider.readDeviceLogs(serial, lines),
      tailDeviceLogs: (serial: string) => context.adbProvider.tailDeviceLogs(serial),
    };
    const app = await createFastifyApp({ ...context, adbProvider });

    await app.inject({
      method: "POST",
      payload: { direction: "left" },
      url: "/api/devices/emulator-5554/rotation",
    });
    await app.inject({
      method: "POST",
      payload: { mode: "reset" },
      url: "/api/devices/emulator-5554/rotation",
    });

    expect(commands.slice(-3)).toEqual([
      ["cmd", "window", "user-rotation", "free"],
      ["cmd", "window", "fixed-to-user-rotation", "default"],
      ["cmd", "window", "set-ignore-orientation-request", "reset"],
    ]);
    await app.close();
  });

  it("ignores rotation reset requests when no rotation snapshot exists", async () => {
    const app = await createFastifyApp(testContext());

    const response = await app.inject({
      method: "POST",
      payload: { mode: "reset" },
      url: "/api/devices/emulator-5554/rotation",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: "Device emulator-5554 rotation reset", ok: true });
    await app.close();
  });

  it("surfaces Android shell errors from rotation operations", async () => {
    const context = testContext();
    const adbProvider = {
      ...context.adbProvider,
      connect: async (serial: string) => ({
        close: async () => {},
        openSocket: async (name: string) => {
          const session = await context.adbProvider.connect(serial);
          return session.openSocket(name);
        },
        push: async () => {},
        serial,
        shell: async (command: readonly string[]) => ({
          command,
          exit: Promise.resolve(1),
          stderr: singleChunkStream("cmd: inaccessible\n"),
          stdout: emptyByteStream(),
        }),
      }),
      listDevices: () => context.adbProvider.listDevices(),
      readDeviceLogs: (serial: string, lines: number) =>
        context.adbProvider.readDeviceLogs(serial, lines),
      tailDeviceLogs: (serial: string) => context.adbProvider.tailDeviceLogs(serial),
    };
    const app = await createFastifyApp({ ...context, adbProvider });

    const response = await app.inject({
      method: "POST",
      payload: { direction: "right" },
      url: "/api/devices/emulator-5554/rotation",
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain("cmd: inaccessible");
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

  it("uses requested video settings when opening the device session", async () => {
    const context = testContext();
    const app = await createFastifyApp(context);

    const created = await app.inject({
      method: "POST",
      payload: { serial: "emulator-5554", video: { bitrateMbps: 12, fps: 60 } },
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(context.deviceServer.startedVideos).toEqual([{ bitrateMbps: 12, fps: 60 }]);
    ws.terminate();
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

  it("rejects unsupported video settings", async () => {
    const app = await createFastifyApp(testContext());

    const response = await app.inject({
      method: "POST",
      payload: { serial: "emulator-5554", video: { bitrateMbps: 6, fps: 24 } },
      url: "/api/sessions",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "supported video settings are required" });
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

    expect(
      (
        await app.inject({
          headers: {
            host: "evil.example",
            origin: "http://127.0.0.1:7391",
            "sec-websocket-protocol": binaryWebSocketProtocol,
          },
          method: "GET",
          url: `/ws/session/${session.sessionId}?token=${session.token}`,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          headers: {
            host: "127.0.0.1:7391",
            origin: "http://evil.example",
            "sec-websocket-protocol": binaryWebSocketProtocol,
          },
          method: "GET",
          url: `/ws/session/${session.sessionId}?token=${session.token}`,
        })
      ).statusCode,
    ).toBe(403);

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

  it("stops a device session that resolves after the browser socket already closed", async () => {
    let releaseStart: (() => void) | undefined;
    const stopped: string[] = [];
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
            stop: async () => {
              stopped.push(serial);
            },
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

    ws.terminate();
    releaseStart?.();
    await waitForCondition(() => stopped.length === 1);

    expect(stopped).toEqual(["emulator-5554"]);
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

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- polling must wait between predicate checks.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for condition");
}

function savedRotationShellOutput(command: readonly string[]): string {
  if (command.join(" ") === "cmd window fixed-to-user-rotation") {
    return "enabled\n";
  }
  if (command.join(" ") === "cmd window get-ignore-orientation-request") {
    return "false\n";
  }
  if (command.join(" ") === "cmd window user-rotation") {
    return "lock 2\n";
  }
  return "\n";
}

function unlockedRotationShellOutput(command: readonly string[]): string {
  if (command.join(" ") === "cmd window fixed-to-user-rotation") {
    return "disabled\n";
  }
  if (command.join(" ") === "cmd window get-ignore-orientation-request") {
    return "true\n";
  }
  if (command.join(" ") === "cmd window user-rotation") {
    return "free\n";
  }
  if (command.join(" ") === "dumpsys display") {
    return "DisplayInfo{mCurrentOrientation=3}\n";
  }
  return "\n";
}

function unknownRotationShellOutput(command: readonly string[]): string {
  if (command.join(" ") === "cmd window fixed-to-user-rotation") {
    return "not supported\n";
  }
  if (command.join(" ") === "cmd window get-ignore-orientation-request") {
    return "unknown\n";
  }
  if (command.join(" ") === "cmd window user-rotation") {
    return "free\n";
  }
  return "\n";
}

async function* emptyByteStream(): AsyncIterable<Uint8Array> {}

async function* singleChunkStream(value: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(value);
}

function testContext(
  config: AgentConfig = {
    authToken: "secret",
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
  const startedVideos: Array<{ readonly bitrateMbps: number; readonly fps: number }> = [];
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
      startedVideos,
      stopCalls,
      writes,
      pushFromDevice(frame: Uint8Array) {
        deviceFrames.push(frame);
        pendingDeviceFrame?.();
      },
      async start(serial: string, video: { readonly bitrateMbps: number; readonly fps: number }) {
        startedSerials.push(serial);
        startedVideos.push(video);
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
