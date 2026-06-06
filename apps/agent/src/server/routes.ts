import { FastifyInstance } from "fastify";
import { AdbProvider } from "@droid-webscr/adb";
import { AgentConfig } from "@droid-webscr/config";
import { DeviceServer } from "../device-server/start.js";
import { SessionManager } from "../session/session-manager.js";

export interface RouteContext {
  readonly adbProvider: AdbProvider;
  readonly config: AgentConfig;
  readonly deviceServer: DeviceServer;
  readonly sessionManager: SessionManager;
}

export function registerRoutes(app: FastifyInstance, context: RouteContext): void {
  app.get("/api/health", async () => ({
    status: "ok",
    version: "0.0.0",
  }));

  app.get("/api/devices", async () => ({
    devices: await context.adbProvider.listDevices(),
  }));

  app.post("/api/sessions", async (request, reply) => {
    const payload = request.body as { serial?: string } | undefined;
    if (!payload?.serial) {
      return reply.code(400).send({ error: "serial is required" });
    }
    const session = await context.sessionManager.create(payload.serial);
    return reply.code(201).send(session);
  });
}
