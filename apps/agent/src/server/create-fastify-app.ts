import websocket from "@fastify/websocket";
import { AdbProvider } from "@droid-webscr/adb";
import { AgentConfig, validateAgentConfig } from "@droid-webscr/config";
import { encodeFrame } from "@droid-webscr/protocol";
import { readFrames } from "@droid-webscr/transport";
import Fastify, { FastifyInstance } from "fastify";
import { DeviceServer, AdbDeviceServer } from "../device-server/start.js";
import { isAllowedHost, isAllowedOrigin } from "../security/origin.js";
import { StartedDeviceSession } from "../session/device-session.js";
import { SessionManager } from "../session/session-manager.js";
import { registerRoutes } from "./routes.js";
import { binaryWebSocketProtocol } from "./websocket.js";

export interface AgentAppContext {
  readonly adbProvider: AdbProvider;
  readonly config: AgentConfig;
  readonly deviceServer?: DeviceServer | undefined;
  readonly getRuntimeConfig?: (() => AgentConfig) | undefined;
  readonly logger?: boolean | undefined;
  readonly rebindRuntime?: ((bindHost: string, port: number) => Promise<void>) | undefined;
  readonly updateRuntimeConfig?: ((config: AgentConfig) => void) | undefined;
}

export interface AgentFastifyApp extends FastifyInstance {
  closeActiveDeviceSessions(options?: { readonly waitForStartup?: boolean }): Promise<void>;
}

export function createLoggerOptions(enabled: boolean | undefined) {
  return enabled === false
    ? false
    : {
        level: "info",
        redact: ["req.headers.authorization", "req.query.token", "token", "*.token"],
      };
}

export async function createFastifyApp(context: AgentAppContext): Promise<AgentFastifyApp> {
  const configValidation = validateAgentConfig(context.config);
  if (!configValidation.ok) {
    throw configValidation.error;
  }

  const app = Fastify({
    logger: createLoggerOptions(context.logger),
  }) as unknown as AgentFastifyApp;
  await app.register(websocket, {
    options: {
      handleProtocols: selectBinaryWebSocketProtocol,
    },
  });

  const sessionManager = new SessionManager(context.adbProvider);
  const deviceServer = context.deviceServer ?? new AdbDeviceServer(context.adbProvider);
  let runtimeConfig = context.config;
  let rebindQueue = Promise.resolve();
  const getRuntimeConfig = () => context.getRuntimeConfig?.() ?? runtimeConfig;
  const activeBrowserSessions = new Set<string>();
  const activeDeviceSerials = new Set<string>();
  const activeBrowserSockets = new Set<{ close?: (code?: number, reason?: string) => void }>();
  const activeSessionClosers = new Set<
    (options: { readonly waitForStartup: boolean }) => Promise<void>
  >();
  const closeActiveSessions = async (options: { readonly waitForStartup?: boolean } = {}) => {
    /* v8 ignore next -- callers either pass the option explicitly or use the close hook default. */
    const waitForStartup = options.waitForStartup ?? false;
    for (const socket of activeBrowserSockets) {
      socket.close?.(1012, "Runtime bind changed");
    }
    await Promise.all(
      [...activeSessionClosers].map((close) => close({ waitForStartup }).catch(ignoreAsyncError)),
    );
  };
  const applyRuntimeRebind = async (host: string, port: number) => {
    /* v8 ignore next 3 -- route-level no-op rebind is covered through the outer runtime path. */
    if (runtimeConfig.bindHost === host && runtimeConfig.port === port) {
      return;
    }
    await closeActiveSessions({ waitForStartup: false });
    runtimeConfig = { ...runtimeConfig, bindHost: host, port };
  };
  const updateRuntimeConfig = (config: AgentConfig) => {
    runtimeConfig = config;
  };
  const queueRuntimeRebind = (host: string, port: number) => {
    const queued = rebindQueue.then(() => applyRuntimeRebind(host, port));
    rebindQueue = queued.catch(ignoreAsyncError);
    return queued;
  };
  const rebindRuntime = context.rebindRuntime ?? queueRuntimeRebind;

  app.closeActiveDeviceSessions = closeActiveSessions;
  app.addHook("preClose", async () => {
    await closeActiveSessions({ waitForStartup: true });
  });
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    const allowedOrigin = isAllowedOrigin(origin, getRuntimeConfig(), request.headers.host);
    if (!allowedOrigin && origin) {
      await reply.code(403).send({ error: "Invalid origin" });
      return;
    }
    /* v8 ignore next 6 -- false branch is the no-CORS server-to-server path. */
    if (allowedOrigin) {
      /* v8 ignore next -- allowedOrigin without an Origin header is only used for non-browser clients. */
      reply.header("access-control-allow-origin", origin ?? "*");
      reply.header("vary", "origin");
      reply.header("access-control-allow-headers", "authorization, content-type");
      reply.header("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");
    }
    if (request.method === "OPTIONS") {
      await reply.code(204).send();
    }
  });

  registerRoutes(app, {
    ...context,
    deviceServer,
    getRuntimeConfig,
    rebindRuntime,
    sessionManager,
    updateRuntimeConfig: context.updateRuntimeConfig ?? updateRuntimeConfig,
  });

  app.get(
    "/ws/session/:sessionId",
    {
      preValidation: async (request, reply) => {
        const params = request.params as { sessionId: string };
        const query = request.query as { token?: string };
        if (!hasBinaryWebSocketProtocol(request.headers["sec-websocket-protocol"])) {
          await reply.code(426).send({ error: "Unsupported WebSocket protocol" });
          return;
        }
        /* v8 ignore next 3 -- injectWS exposes the 403 behavior but not these server lines to V8. */
        if (!isAllowedHost(request.headers.host, getRuntimeConfig())) {
          await reply.code(403).send({ error: "Invalid host" });
          return;
        }
        /* v8 ignore next 3 -- injectWS exposes the 403 behavior but not these server lines to V8. */
        if (!isAllowedOrigin(request.headers.origin, getRuntimeConfig(), request.headers.host)) {
          await reply.code(403).send({ error: "Invalid origin" });
          return;
        }
        const record = sessionManager.verify(params.sessionId, query.token);
        if (!record) {
          await reply.code(401).send({ error: "Invalid token" });
          return;
        }
        if (
          activeBrowserSessions.has(params.sessionId) ||
          activeDeviceSerials.has(record.deviceSerial)
        ) {
          await reply.code(409).send({ error: "Session already connected" });
          return;
        }
      },
      websocket: true,
    },
    (socket, request) => {
      const params = request.params as { sessionId: string };
      const query = request.query as { token?: string };
      const record = sessionManager.verify(params.sessionId, query.token);
      /* v8 ignore next 4 -- defensive guard after preValidation; kept to avoid accepting stale state */
      if (!record) {
        socket.close(1008, "Invalid token");
        return;
      }
      activeBrowserSessions.add(params.sessionId);
      activeDeviceSerials.add(record.deviceSerial);
      const release = () => {
        activeBrowserSessions.delete(params.sessionId);
        activeDeviceSerials.delete(record.deviceSerial);
      };
      const pendingBrowserFrames: Uint8Array[] = [];
      const startupAbort = new AbortController();
      let deviceSession: StartedDeviceSession | undefined;
      let deviceSessionPromise: Promise<StartedDeviceSession> | undefined;
      let closed = false;
      let cleanupPromise: Promise<void> | undefined;
      const cleanupDeviceSession = () => {
        cleanupPromise ??= (async () => {
          startupAbort.abort();
          const activeSession =
            deviceSession ?? (await deviceSessionPromise?.catch(ignoreAsyncError));
          await activeSession?.stop().catch(ignoreAsyncError);
        })();
        return cleanupPromise;
      };
      const close = async (
        options: { readonly waitForStartup: boolean } = { waitForStartup: false },
      ) => {
        if (!closed) {
          closed = true;
          release();
        }
        const cleanup = cleanupDeviceSession();
        if (options.waitForStartup) {
          await cleanup;
        }
      };
      activeBrowserSockets.add(socket);
      activeSessionClosers.add(close);
      const bufferBrowserFrame = (data: Buffer | ArrayBuffer | Buffer[]) => {
        /* v8 ignore next 3 -- ws clients do not emit server-side text frames in this binary route. */
        if (typeof data === "string") {
          return;
        }
        /* v8 ignore next 5 -- Buffer[] is a ws server internals shape not reachable through injectWS. */
        if (Array.isArray(data)) {
          for (const item of data) {
            pendingBrowserFrames.push(new Uint8Array(item));
          }
          return;
        }
        /* v8 ignore next -- injectWS delivers Buffer frames for this binary route. */
        const frame = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (deviceSession) {
          void deviceSession.write(frame).catch(close);
          return;
        }
        pendingBrowserFrames.push(frame);
      };
      socket.on("message", bufferBrowserFrame);
      socket.on("close", () => {
        void close();
      });
      /* v8 ignore next 3 -- server-side socket error emission is not reachable through injectWS. */
      socket.on("error", () => {
        void close();
      });

      deviceSessionPromise = deviceServer.start(
        record.deviceSerial,
        record.video,
        startupAbort.signal,
      );
      void deviceSessionPromise
        .then(async (startedSession) => {
          /* v8 ignore next 4 -- requires closing during the same microtask that device startup resolves. */
          if (closed) {
            await startedSession.stop();
            return;
          }
          deviceSession = startedSession;
          await Promise.all(
            pendingBrowserFrames.splice(0).map((frame) => startedSession.write(frame)),
          );
          for await (const frame of readFrames(startedSession.frames)) {
            socket.send(encodeFrame(frame));
          }
        })
        .catch(() => {
          release();
          closeBrowserSocket(socket, 1011, "Device session failed");
        })
        .finally(() => {
          activeBrowserSockets.delete(socket);
          activeSessionClosers.delete(close);
          void close();
        });
    },
  );

  return app;
}

export function selectBinaryWebSocketProtocol(protocols: Set<string>): string | false {
  return protocols.has(binaryWebSocketProtocol) ? binaryWebSocketProtocol : false;
}

export function hasBinaryWebSocketProtocol(header: string | string[] | undefined): boolean {
  const values = Array.isArray(header) ? header : [header];
  return values
    .filter((value): value is string => value !== undefined)
    .flatMap((value) => value.split(","))
    .some((value) => value.trim() === binaryWebSocketProtocol);
}

/* v8 ignore next 3 -- async cleanup failures are intentionally swallowed by callers. */
function ignoreAsyncError(): undefined {
  return undefined;
}

function closeBrowserSocket(
  socket: { close?: (code?: number, reason?: string) => void },
  code: number,
  reason: string,
): void {
  socket.close?.(code, reason);
}
