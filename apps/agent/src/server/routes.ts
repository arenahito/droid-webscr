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

  app.get("/api/health", async () => ({
    status: "ok",
    version: "0.0.0",
  }));

  app.get("/api/config", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    return {
      bindHost: context.config.bindHost,
      clipboardEnabled: context.config.clipboard.enabled,
      port: context.config.port,
    };
  });

  app.get("/api/share-url", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    return {
      url: `http://${context.config.bindHost}:${context.config.port}`,
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
    const payload = request.body as { serial?: string } | undefined;
    if (!payload?.serial) {
      return reply.code(400).send({ error: "serial is required" });
    }
    const session = await context.sessionManager.create(payload.serial);
    return reply.code(201).send(session);
  });
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
