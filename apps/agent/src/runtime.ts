import { AdbProvider, SystemAdbProvider } from "@droid-webscr/adb";
import { AgentConfig, defaultAgentConfig } from "@droid-webscr/config";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type DeviceServerArtifact,
  resolveDeviceServerArtifact,
} from "./device-server/artifact.js";
import { AdbDeviceServer } from "./device-server/start.js";
import {
  AgentFastifyApp,
  createFastifyApp,
  type WebUiProvider,
} from "./server/create-fastify-app.js";

export interface AgentRuntime {
  close(): Promise<void>;
  readonly url: string;
}

export type RuntimeSignal = "SIGINT" | "SIGTERM";

export interface RuntimeSignalSource {
  off(signal: RuntimeSignal, listener: () => void | Promise<void>): unknown;
  once(signal: RuntimeSignal, listener: () => void | Promise<void>): unknown;
}

export interface RuntimeShutdownOptions {
  readonly onError: (error: unknown) => void;
  readonly signalSource?: RuntimeSignalSource | undefined;
}

export interface StartAgentOptions {
  readonly adbProvider?: AdbProvider | undefined;
  readonly config?: AgentConfig | undefined;
  readonly deviceServerArtifact?: DeviceServerArtifact | undefined;
  readonly webUi?: WebUiProvider | undefined;
}

export async function startAgent(options: StartAgentOptions = {}) {
  /* v8 ignore next -- default runtime construction would bind the real configured agent port. */
  const adbProvider = options.adbProvider ?? new SystemAdbProvider();
  /* v8 ignore next -- default config is reserved for the real CLI startup path. */
  let runtimeConfig = options.config ?? defaultAgentConfig;
  let currentApp: AgentFastifyApp | undefined;
  let closePromise: Promise<void> | undefined;
  let rebindQueue = Promise.resolve();
  const closingPorts = new Map<number, Promise<void>>();
  let resolvedArtifact: DeviceServerArtifact;

  const createRuntimeApp = (agentConfig: AgentConfig) =>
    createFastifyApp({
      adbProvider,
      config: agentConfig,
      deviceServer: new AdbDeviceServer(adbProvider, resolvedArtifact),
      getRuntimeConfig: () => runtimeConfig,
      rebindRuntime,
      updateRuntimeConfig: (nextConfig) => {
        runtimeConfig = nextConfig;
      },
      webUi: options.webUi,
    });

  const applyRuntimeRebind = async (bindHost: string, port: number) => {
    const previousApp = currentApp;
    const previousPort = runtimeConfig.port;
    if (runtimeConfig.bindHost === bindHost && runtimeConfig.port === port) {
      return;
    }
    const reusesPort = runtimeConfig.port === port;
    await previousApp?.closeActiveDeviceSessions({ waitForStartup: false });
    if (reusesPort && previousApp) {
      previousApp.server.close();
    } else {
      await closingPorts.get(port);
    }
    const nextApp = await createRuntimeApp({ ...runtimeConfig, bindHost, port });
    try {
      await listenWithRetry(nextApp, bindHost, port);
    } catch (error) {
      await nextApp.close();
      /* v8 ignore next 4 -- same-port rollback failure requires racing the OS listener handoff. */
      if (reusesPort && previousApp) {
        await listenWithRetry(previousApp, runtimeConfig.bindHost, runtimeConfig.port);
      }
      throw error;
    }
    runtimeConfig = { ...runtimeConfig, bindHost, port: readBoundPort(nextApp, port) };
    currentApp = nextApp;
    /* v8 ignore next 3 -- startup has no previous app; rebind paths cover scheduled close. */
    if (previousApp) {
      scheduleClose(previousApp, previousPort, closingPorts);
    }
  };

  function rebindRuntime(bindHost: string, port: number) {
    const queued = rebindQueue.then(() => applyRuntimeRebind(bindHost, port));
    rebindQueue = queued.catch(ignoreAsyncError);
    return queued;
  }

  try {
    resolvedArtifact = options.deviceServerArtifact ?? (await resolveDeviceServerArtifact());
    currentApp = await createRuntimeApp(runtimeConfig);
    await currentApp.listen({ host: runtimeConfig.bindHost, port: runtimeConfig.port });
  } catch (error) {
    try {
      await currentApp?.close();
    } finally {
      await options.webUi?.close?.();
    }
    throw error;
  }
  runtimeConfig = { ...runtimeConfig, port: readBoundPort(currentApp, runtimeConfig.port) };
  return {
    close: () => {
      closePromise ??= (async () => {
        try {
          await rebindQueue;
          await currentApp?.closeActiveDeviceSessions({ waitForStartup: true });
          await currentApp?.close();
          await Promise.all(closingPorts.values());
        } finally {
          currentApp = undefined;
          await options.webUi?.close?.();
        }
      })();
      return closePromise;
    },
    get url() {
      return createRuntimeUrl(runtimeConfig.bindHost, runtimeConfig.port);
    },
  } satisfies AgentRuntime;
}

export function registerRuntimeShutdown(
  runtime: AgentRuntime,
  options: RuntimeShutdownOptions,
): void {
  const signalSource = options.signalSource ?? process;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      try {
        await runtime.close();
      } catch (error) {
        options.onError(error);
      } finally {
        signalSource.off("SIGINT", shutdown);
        signalSource.off("SIGTERM", shutdown);
      }
    })();
    return shutdownPromise;
  };

  signalSource.once("SIGINT", shutdown);
  signalSource.once("SIGTERM", shutdown);
}

export function createRuntimeUrl(bindHost: string, port: number): string {
  const host = bindHost === "0.0.0.0" || bindHost === "::" ? "127.0.0.1" : bindHost;
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${port}`;
}

export function isDirectRun(moduleUrl: string, argv: readonly string[]): boolean {
  const entrypoint = argv[1];
  if (entrypoint === undefined) {
    return false;
  }
  if (pathToFileURL(entrypoint).href === moduleUrl) {
    return true;
  }

  try {
    return realpathSync.native(entrypoint) === realpathSync.native(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

async function listenWithRetry(
  app: AgentFastifyApp,
  host: string,
  port: number,
  attempt = 0,
): Promise<void> {
  const retryDelayMs = 25;
  const maxAttempts = 80;
  try {
    await app.listen({ host, port });
  } catch (error) {
    if (!isAddressInUse(error) || attempt === maxAttempts - 1) {
      throw error;
    }
    await delay(retryDelayMs);
    await listenWithRetry(app, host, port, attempt + 1);
  }
}

function readBoundPort(app: AgentFastifyApp, fallbackPort: number): number {
  const address = app.server.address();
  if (typeof address === "object" && address?.port) {
    return address.port;
  }
  return fallbackPort;
}

function scheduleClose(
  app: AgentFastifyApp,
  port: number,
  closingPorts: Map<number, Promise<void>>,
): void {
  const closed = new Promise<void>((resolve) => {
    setTimeout(() => {
      void app.close().finally(resolve);
    }, 0);
  }).finally(() => {
    /* v8 ignore next -- only the owner promise removes its tracked closing port. */
    if (closingPorts.get(port) === closed) {
      closingPorts.delete(port);
    }
  });
  closingPorts.set(port, closed);
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EADDRINUSE"
  );
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/* v8 ignore next 3 -- async cleanup failures are intentionally swallowed by callers. */
function ignoreAsyncError(): undefined {
  return undefined;
}
