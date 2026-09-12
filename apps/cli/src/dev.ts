import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  deviceServerArtifactFileName,
  deviceServerArtifactRemotePath,
  isDirectRun,
  startAgent,
  type WebUiProvider,
} from "@droid-webscr/agent";
import { createServer as createViteServer } from "vite";
import packageJson from "../package.json" with { type: "json" };
import { runCli, type RuntimeStartOptions } from "./cli.js";
import { injectInitialConfig } from "./web-ui-runtime.js";

interface DevelopmentViteServer {
  readonly close: () => Promise<void>;
  readonly middlewares: WebUiProvider["devMiddleware"];
  readonly transformIndexHtml: (url: string, html: string) => Promise<string>;
}

export interface DevelopmentWebUiOptions {
  readonly createViteServer?: (() => Promise<DevelopmentViteServer>) | undefined;
  readonly webRoot: string;
}

export interface DevelopmentRuntimeDependencies {
  readonly createWebUi?: typeof createDevelopmentWebUi | undefined;
  readonly startAgent?: typeof startAgent | undefined;
  readonly workspaceRoot?: string | undefined;
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = dirname(dirname(packageRoot));

export async function createDevelopmentWebUi(
  options: DevelopmentWebUiOptions,
  initialConfig: { readonly authToken: string },
): Promise<WebUiProvider> {
  const createServer =
    options.createViteServer ??
    (() =>
      createViteServer({
        appType: "custom",
        configFile: join(options.webRoot, "vite.config.ts"),
        root: options.webRoot,
        server: {
          middlewareMode: true,
        },
      }));
  const vite = await createServer();
  const indexHtmlPath = join(options.webRoot, "index.html");
  return {
    close: () => vite.close(),
    devMiddleware: vite.middlewares,
    renderIndex: async (url: string) => {
      const html = await readFile(indexHtmlPath, "utf8");
      const transformed = await vite.transformIndexHtml(url, html);
      return injectInitialConfig(transformed, initialConfig);
    },
  };
}

export async function startDevelopmentRuntime(
  options: RuntimeStartOptions,
  dependencies: DevelopmentRuntimeDependencies = {},
) {
  const developmentRoot = dependencies.workspaceRoot ?? workspaceRoot;
  const createWebUi = dependencies.createWebUi ?? createDevelopmentWebUi;
  const start = dependencies.startAgent ?? startAgent;
  return start({
    config: {
      authToken: options.authToken,
      bindHost: options.host,
      clipboard: { enabled: false },
      port: options.port,
    },
    deviceServerArtifact: {
      localPath: join(developmentRoot, "android", "server", "build", deviceServerArtifactFileName),
      remotePath: deviceServerArtifactRemotePath,
    },
    webUi: await createWebUi(
      { webRoot: join(developmentRoot, "apps", "web") },
      { authToken: options.authToken },
    ),
  });
}

if (isDirectRun(import.meta.url, process.argv)) {
  runCli(process.argv, {
    packageVersion: packageJson.version,
    startRuntime: startDevelopmentRuntime,
  }).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
