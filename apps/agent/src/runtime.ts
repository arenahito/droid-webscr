import { AdbProvider, SystemAdbProvider } from "@droid-webscr/adb";
import { AgentConfig, defaultAgentConfig } from "@droid-webscr/config";
import { pathToFileURL } from "node:url";
import {
  type DeviceServerArtifact,
  resolveDeviceServerArtifact,
} from "./device-server/artifact.js";
import { AdbDeviceServer } from "./device-server/start.js";
import { AgentFastifyApp, createFastifyApp } from "./server/create-fastify-app.js";

export interface AgentRuntime {
  close(): Promise<void>;
}

export interface StartAgentOptions {
  readonly adbProvider?: AdbProvider | undefined;
  readonly config?: AgentConfig | undefined;
  readonly deviceServerArtifact?: DeviceServerArtifact | undefined;
}

export async function startAgent(options: StartAgentOptions = {}) {
  /* v8 ignore next -- default runtime construction would bind the real configured agent port. */
  const adbProvider = options.adbProvider ?? new SystemAdbProvider();
  /* v8 ignore next -- default config is reserved for the real CLI startup path. */
  let runtimeConfig = options.config ?? defaultAgentConfig;
  let currentApp: AgentFastifyApp | undefined;
  let rebindQueue = Promise.resolve();
  const closingPorts = new Map<number, Promise<void>>();
  const resolvedArtifact = options.deviceServerArtifact ?? (await resolveDeviceServerArtifact());

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
    runtimeConfig = { ...runtimeConfig, bindHost, port };
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

  currentApp = await createRuntimeApp(runtimeConfig);
  await currentApp.listen({ host: runtimeConfig.bindHost, port: runtimeConfig.port });
  return {
    close: async () => {
      await rebindQueue;
      await currentApp?.closeActiveDeviceSessions({ waitForStartup: true });
      await currentApp?.close();
      await Promise.all(closingPorts.values());
      currentApp = undefined;
    },
  } satisfies AgentRuntime;
}

export function isDirectRun(moduleUrl: string, argv: readonly string[]): boolean {
  const entrypoint = argv[1];
  return entrypoint !== undefined && pathToFileURL(entrypoint).href === moduleUrl;
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
