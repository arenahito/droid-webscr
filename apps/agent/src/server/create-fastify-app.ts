import websocket from "@fastify/websocket";
import { AdbProvider } from "@droid-webscr/adb";
import { AgentConfig, validateAgentConfig } from "@droid-webscr/config";
import { encodeFrame } from "@droid-webscr/protocol";
import { readFrames } from "@droid-webscr/transport";
import Fastify from "fastify";
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
  readonly logger?: boolean | undefined;
}

export function createLoggerOptions(enabled: boolean | undefined) {
  return enabled === false
    ? false
    : {
        level: "info",
        redact: ["req.headers.authorization", "req.query.token", "token", "*.token"],
      };
}

export async function createFastifyApp(context: AgentAppContext) {
  const configValidation = validateAgentConfig(context.config);
  if (!configValidation.ok) {
    throw configValidation.error;
  }

  const app = Fastify({
    logger: createLoggerOptions(context.logger),
  });
  await app.register(websocket, {
    options: {
      handleProtocols: selectBinaryWebSocketProtocol,
    },
  });

  const sessionManager = new SessionManager(context.adbProvider);
  const deviceServer = context.deviceServer ?? new AdbDeviceServer(context.adbProvider);
  const activeBrowserSessions = new Set<string>();
  const activeDeviceSerials = new Set<string>();

  registerRoutes(app, {
    ...context,
    deviceServer,
    sessionManager,
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
        if (!isAllowedHost(request.headers.host, context.config)) {
          await reply.code(403).send({ error: "Invalid host" });
          return;
        }
        if (!isAllowedOrigin(request.headers.origin, context.config, request.headers.host)) {
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
      let deviceSession: StartedDeviceSession | undefined;
      let deviceSessionPromise: Promise<StartedDeviceSession> | undefined;
      let closed = false;
      const close = async () => {
        if (closed) {
          return;
        }
        closed = true;
        release();
        const activeSession = deviceSession ?? (await deviceSessionPromise?.catch(() => undefined));
        await activeSession?.stop().catch(() => undefined);
      };
      const bufferBrowserFrame = (data: Buffer | ArrayBuffer | Buffer[]) => {
        if (typeof data === "string") {
          return;
        }
        if (Array.isArray(data)) {
          for (const item of data) {
            pendingBrowserFrames.push(new Uint8Array(item));
          }
          return;
        }
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
      socket.on("error", () => {
        void close();
      });

      deviceSessionPromise = deviceServer.start(record.deviceSerial, record.video);
      void deviceSessionPromise
        .then(async (startedSession) => {
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

function closeBrowserSocket(
  socket: { close?: (code?: number, reason?: string) => void },
  code: number,
  reason: string,
): void {
  socket.close?.(code, reason);
}
