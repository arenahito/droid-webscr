import { FastifyInstance } from "fastify";
import { AdbProvider } from "@droid-webscr/adb";
import { AgentConfig } from "@droid-webscr/config";
import { DeviceServer } from "../device-server/start.js";
import { validateAgentAuthHeader } from "../security/auth.js";
import { SessionManager } from "../session/session-manager.js";

export interface RouteContext {
  readonly adbProvider: AdbProvider;
  readonly config: AgentConfig;
  readonly deviceServer: DeviceServer;
  readonly getRuntimeConfig?: (() => AgentConfig) | undefined;
  readonly rebindRuntime?: ((bindHost: string, port: number) => Promise<void>) | undefined;
  readonly sessionManager: SessionManager;
  readonly updateRuntimeConfig?: ((config: AgentConfig) => void) | undefined;
}

export function registerRoutes(app: FastifyInstance, context: RouteContext): void {
  const runtimeConfig = () => context.getRuntimeConfig?.() ?? context.config;
  const updateRuntimeConfig =
    context.updateRuntimeConfig ??
    (() => {
      return;
    });

  app.get("/api/health", async () => ({
    status: "ok",
    version: "0.0.0",
  }));

  app.get("/api/config", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    const config = runtimeConfig();
    return {
      bindHost: config.bindHost,
      clipboardEnabled: config.clipboard.enabled,
      port: config.port,
    };
  });

  app.get("/api/share-url", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    return {
      url: createShareUrl(runtimeConfig().bindHost, runtimeConfig().port),
    };
  });

  app.patch("/api/config/bind", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    const payload = request.body as { bindHost?: string; port?: number } | undefined;
    const bindHost = payload?.bindHost?.trim();
    const rawPort = payload?.port;
    const nextPort = Number(rawPort);
    if (!bindHost) {
      return reply.code(400).send({ error: "bindHost is required" });
    }
    if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
      return reply.code(400).send({ error: "port must be a valid TCP port" });
    }
    if (!isLocalBind(bindHost) && !context.config.authToken) {
      return reply.code(400).send({ error: "Non-local bind addresses require authToken." });
    }
    await context.rebindRuntime?.(bindHost, nextPort);
    const response = {
      bindHost,
      clipboardEnabled: runtimeConfig().clipboard.enabled,
      message: `Agent is now listening on ${bindHost}:${nextPort}.`,
      ok: true,
      port: nextPort,
      shareUrl: createShareUrl(bindHost, nextPort),
    };
    return response;
  });

  app.patch("/api/config/clipboard", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    const payload = request.body as { enabled?: unknown } | undefined;
    if (typeof payload?.enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled must be a boolean" });
    }
    const nextConfig = {
      ...runtimeConfig(),
      clipboard: { enabled: payload.enabled },
    };
    updateRuntimeConfig(nextConfig);
    const config = runtimeConfig();
    return {
      bindHost: config.bindHost,
      clipboardEnabled: config.clipboard.enabled,
      message: `Clipboard sync ${config.clipboard.enabled ? "enabled" : "disabled"}`,
      ok: true,
      port: config.port,
    };
  });

  app.get("/api/devices", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    return {
      devices: await context.adbProvider.listDevices(),
    };
  });

  app.post("/api/devices/scan", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    return {
      devices: await context.adbProvider.listDevices(),
    };
  });

  app.post("/api/devices/connect", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    const payload = request.body as { endpoint?: string } | undefined;
    const endpoint = payload?.endpoint?.trim();
    if (!endpoint) {
      return reply.code(400).send({ error: "endpoint is required" });
    }
    await context.adbProvider.connectEndpoint?.(endpoint);
    return { message: `Endpoint ${endpoint} connected`, ok: true };
  });

  app.get("/api/devices/:serial/logs", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    const params = request.params as { serial: string };
    const query = request.query as { lines?: string } | undefined;
    const lines = Number(query?.lines ?? 200);
    if (!Number.isInteger(lines) || lines < 1 || lines > 1000) {
      return reply.code(400).send({ error: "lines must be between 1 and 1000" });
    }
    return {
      lines: await context.adbProvider.readDeviceLogs(params.serial, lines),
      ok: true,
      serial: params.serial,
    };
  });

  app.get("/api/devices/:serial/logs/tail", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    const params = request.params as { serial: string };
    const tail = await context.adbProvider.tailDeviceLogs(params.serial);
    reply.header("cache-control", "no-cache");
    reply.header("connection", "keep-alive");
    reply.header("content-type", "text/event-stream; charset=utf-8");
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) {
        reply.raw.setHeader(name, value);
      }
    }
    reply.raw.statusCode = 200;
    request.raw.once("close", () => {
      void tail.close();
    });
    try {
      for await (const line of tail.lines) {
        reply.raw.write(formatSseData(line));
      }
    } finally {
      await tail.close();
      reply.raw.end();
    }
    return reply;
  });

  app.post("/api/devices/:serial/disconnect", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    const params = request.params as { serial: string };
    await context.adbProvider.disconnect?.(params.serial);
    return { message: `Device ${params.serial} disconnected`, ok: true };
  });

  app.post("/api/sessions", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    const payload = request.body as
      | {
          readonly serial?: string;
          readonly video?: { readonly bitrateMbps?: number; readonly fps?: number };
        }
      | undefined;
    if (!payload?.serial) {
      return reply.code(400).send({ error: "serial is required" });
    }
    const video = parseSessionVideoSettings(payload.video);
    if (!video) {
      return reply.code(400).send({ error: "supported video settings are required" });
    }
    const session = await context.sessionManager.create(payload.serial, video);
    return reply.code(201).send(session);
  });
}

function formatSseData(value: string): string {
  return `${value
    .split(/\r?\n/)
    .map((line) => `data: ${line}`)
    .join("\n")}\n\n`;
}

function parseSessionVideoSettings(
  video: { readonly bitrateMbps?: number; readonly fps?: number } | undefined,
): { readonly bitrateMbps: number; readonly fps: number } | undefined {
  if (!video) {
    return { bitrateMbps: 4, fps: 30 };
  }
  const bitrateMbps = video?.bitrateMbps;
  const fps = video?.fps;
  if (
    (bitrateMbps === 2 || bitrateMbps === 4 || bitrateMbps === 8 || bitrateMbps === 12) &&
    (fps === 15 || fps === 30 || fps === 60)
  ) {
    return { bitrateMbps, fps };
  }
  return undefined;
}

function isLocalBind(bindHost: string): boolean {
  return bindHost === "127.0.0.1" || bindHost === "localhost" || bindHost === "::1";
}

function createShareUrl(bindHost: string, port: number): string {
  if (bindHost === "0.0.0.0" || bindHost === "::") {
    return `http://127.0.0.1:${port}`;
  }
  const host = bindHost.includes(":") && !bindHost.startsWith("[") ? `[${bindHost}]` : bindHost;
  return `http://${host}:${port}`;
}
