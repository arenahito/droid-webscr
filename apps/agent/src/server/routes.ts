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

/* v8 ignore next 3 -- createFastifyApp always supplies the runtime updater. */
const noopUpdateRuntimeConfig = () => {
  return;
};

export function registerRoutes(app: FastifyInstance, context: RouteContext): void {
  /* v8 ignore next -- createFastifyApp supplies getRuntimeConfig for runtime-aware routes. */
  const runtimeConfig = () => context.getRuntimeConfig?.() ?? context.config;
  /* v8 ignore next -- createFastifyApp always supplies the runtime updater. */
  const updateRuntimeConfig = context.updateRuntimeConfig ?? noopUpdateRuntimeConfig;

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

  const rotationSnapshots = new Map<string, RotationSettings>();

  app.post("/api/devices/:serial/rotation", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    const params = request.params as { serial: string };
    const payload = request.body as { direction?: unknown; mode?: unknown } | undefined;
    if (payload?.mode === "reset") {
      await restoreDeviceRotation(context.adbProvider, params.serial, rotationSnapshots);
      return { message: `Device ${params.serial} rotation reset`, ok: true };
    }
    if (payload?.direction !== "left" && payload?.direction !== "right") {
      return reply.code(400).send({ error: "direction must be left or right" });
    }
    await rotateDevice(context.adbProvider, params.serial, payload.direction, rotationSnapshots);
    return { message: `Device ${params.serial} rotated ${payload.direction}`, ok: true };
  });

  app.get("/api/devices/:serial/logs", async (request, reply) => {
    if (!validateAgentAuthHeader(request.headers.authorization, context.config)) {
      return reply.code(401).send({ error: "Invalid agent auth token" });
    }
    const params = request.params as { serial: string };
    const query = request.query as { lines?: string } | undefined;
    /* v8 ignore next -- omitted query is the default-path branch for the same log reader. */
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
      /* v8 ignore next -- Fastify headers are defined for the SSE route before copying to raw response. */
      if (value !== undefined) {
        reply.raw.setHeader(name, value);
      }
    }
    reply.raw.statusCode = 200;
    /* v8 ignore next 3 -- Fastify inject cannot naturally abort this streaming response. */
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

interface RotationSettings {
  readonly fixedToUserRotation: string;
  readonly ignoreOrientationRequest: string;
  readonly userRotation: string;
}

async function rotateDevice(
  adbProvider: AdbProvider,
  serial: string,
  direction: "left" | "right",
  snapshots: Map<string, RotationSettings>,
): Promise<void> {
  const session = await adbProvider.connect(serial);
  try {
    /* v8 ignore next -- second rotate before reset reuses the same saved snapshot. */
    if (!snapshots.has(serial)) {
      snapshots.set(serial, {
        fixedToUserRotation: await runShellText(session, [
          "cmd",
          "window",
          "fixed-to-user-rotation",
        ]),
        ignoreOrientationRequest: await runShellText(session, [
          "cmd",
          "window",
          "get-ignore-orientation-request",
        ]),
        userRotation: await runShellText(session, ["cmd", "window", "user-rotation"]),
      });
    }
    const current = await readDeviceOrientation(session);
    const delta = direction === "left" ? -1 : 1;
    const next = (((current + delta) % 4) + 4) % 4;
    await runShellText(session, ["cmd", "window", "fixed-to-user-rotation", "enabled"]);
    await runShellText(session, ["cmd", "window", "set-ignore-orientation-request", "true"]);
    await runShellText(session, ["cmd", "window", "user-rotation", "lock", String(next)]);
  } finally {
    await session.close();
  }
}

async function restoreDeviceRotation(
  adbProvider: AdbProvider,
  serial: string,
  snapshots: Map<string, RotationSettings>,
): Promise<void> {
  const settings = snapshots.get(serial);
  if (!settings) {
    return;
  }
  snapshots.delete(serial);
  const session = await adbProvider.connect(serial);
  try {
    const locked = parseLockedUserRotation(settings.userRotation);
    if (locked === undefined) {
      await runShellText(session, ["cmd", "window", "user-rotation", "free"]);
    } else {
      await runShellText(session, ["cmd", "window", "user-rotation", "lock", String(locked)]);
    }
    await runShellText(session, [
      "cmd",
      "window",
      "fixed-to-user-rotation",
      parseFixedToUserRotation(settings.fixedToUserRotation),
    ]);
    await runShellText(session, [
      "cmd",
      "window",
      "set-ignore-orientation-request",
      parseIgnoreOrientationRequest(settings.ignoreOrientationRequest),
    ]);
  } finally {
    await session.close();
  }
}

async function readDeviceOrientation(
  session: Awaited<ReturnType<AdbProvider["connect"]>>,
): Promise<number> {
  const userRotation = await runShellText(session, ["cmd", "window", "user-rotation"]);
  return (
    parseLockedUserRotation(userRotation) ??
    parseCurrentOrientation(await runShellText(session, ["dumpsys", "display"])) ??
    0
  );
}

async function runShellText(
  session: Awaited<ReturnType<AdbProvider["connect"]>>,
  command: readonly string[],
): Promise<string> {
  const process = await session.shell(command);
  const [stdout, stderr, exitCode] = await Promise.all([
    collectText(process.stdout),
    collectText(process.stderr),
    process.exit,
  ]);
  if (exitCode !== 0) {
    /* v8 ignore next -- tested shell failures include stderr; this is the no-stderr fallback message. */
    throw new Error(stderr.trim() || `${command.join(" ")} failed with exit code ${exitCode}`);
  }
  return stdout.trim();
}

async function collectText(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  for await (const chunk of chunks) {
    output += decoder.decode(chunk, { stream: true });
  }
  return output + decoder.decode();
}

function parseLockedUserRotation(value: string): number | undefined {
  const match = value.match(/\block\s+([0-3])\b/);
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

function parseCurrentOrientation(value: string): number | undefined {
  const match = value.match(/\bmCurrentOrientation=([0-3])\b/);
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

function parseFixedToUserRotation(value: string): string {
  if (value.toLowerCase().includes("enabled")) {
    return "enabled";
  }
  if (value.toLowerCase().includes("disabled")) {
    return "disabled";
  }
  return "default";
}

function parseIgnoreOrientationRequest(value: string): string {
  if (value.trim().toLowerCase() === "true") {
    return "true";
  }
  if (value.trim().toLowerCase() === "false") {
    return "false";
  }
  return "reset";
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
