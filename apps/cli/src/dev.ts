import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectRun, startAgent, type WebUiProvider } from "@droid-webscr/agent";
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

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = dirname(dirname(packageRoot));
const webRoot = join(workspaceRoot, "apps", "web");

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

export async function startDevelopmentRuntime(options: RuntimeStartOptions) {
  return startAgent({
    config: {
      authToken: options.authToken,
      bindHost: options.host,
      clipboard: { enabled: false },
      port: options.port,
    },
    webUi: await createDevelopmentWebUi({ webRoot }, { authToken: options.authToken }),
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
