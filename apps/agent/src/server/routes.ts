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
  readonly sessionManager: SessionManager;
}

export function registerRoutes(app: FastifyInstance, context: RouteContext): void {
  const deviceAliases = new Map<string, string>();
  let runtimeBind = {
    bindHost: context.config.bindHost,
    port: context.config.port,
  };
  let runtimeClipboardEnabled = context.config.clipboard.enabled;

  app.get("/api/health", async () => ({
    status: "ok",
    version: "0.0.0",
  }));

  app.get("/api/config", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    return {
      bindHost: runtimeBind.bindHost,
      clipboardEnabled: runtimeClipboardEnabled,
      port: runtimeBind.port,
    };
  });

  app.get("/api/share-url", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    return {
      url: createShareUrl(runtimeBind.bindHost, runtimeBind.port),
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
    runtimeBind = { bindHost, port: nextPort };
    return {
      bindHost,
      clipboardEnabled: runtimeClipboardEnabled,
      message: "Runtime bind updated; restart the agent to move the listening socket.",
      ok: true,
      port: nextPort,
      shareUrl: createShareUrl(bindHost, nextPort),
    };
  });

  app.patch("/api/config/clipboard", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    const payload = request.body as { enabled?: unknown } | undefined;
    if (typeof payload?.enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled must be a boolean" });
    }
    runtimeClipboardEnabled = payload.enabled;
    return {
      bindHost: runtimeBind.bindHost,
      clipboardEnabled: runtimeClipboardEnabled,
      message: `Clipboard sync ${runtimeClipboardEnabled ? "enabled" : "disabled"}`,
      ok: true,
      port: runtimeBind.port,
    };
  });

  app.get("/api/devices", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    return {
      devices: applyAliases(await context.adbProvider.listDevices(), deviceAliases),
    };
  });

  app.post("/api/devices/scan", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    return {
      devices: applyAliases(await context.adbProvider.listDevices(), deviceAliases),
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

  app.post("/api/devices/:serial/rename", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    const params = request.params as { serial: string };
    const payload = request.body as { alias?: string } | undefined;
    const alias = payload?.alias?.trim();
    if (!alias) {
      return reply.code(400).send({ error: "alias is required" });
    }
    deviceAliases.set(params.serial, alias);
    return { message: `Device ${params.serial} renamed`, ok: true };
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

function applyAliases<T extends { readonly model?: string | undefined; readonly serial: string }>(
  devices: readonly T[],
  aliases: ReadonlyMap<string, string>,
): T[] {
  return devices.map((device) => {
    const alias = aliases.get(device.serial);
    return alias ? { ...device, model: alias } : device;
  });
}
