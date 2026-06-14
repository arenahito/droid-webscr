import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { registerWebUiRoutes, type AgentRuntime, type WebUiProvider } from "@droid-webscr/agent";

export interface WebUiInitialConfig {
  readonly agentUrl?: string | undefined;
  readonly authToken: string;
}

export interface WebUiRuntimeOptions extends WebUiInitialConfig {
  readonly host: string;
  readonly port: number;
  readonly staticRoot: string;
}

export function createPackagedWebUi(
  staticRoot: string,
  initialConfig: WebUiInitialConfig,
): WebUiProvider {
  return {
    renderIndex: async () =>
      injectInitialConfig(await readFile(join(staticRoot, "index.html"), "utf8"), initialConfig),
    staticRoot,
  };
}

export async function startWebUiRuntime(options: WebUiRuntimeOptions): Promise<AgentRuntime> {
  const app = Fastify({ logger: false });
  registerWebUiRoutes(
    app,
    createPackagedWebUi(options.staticRoot, {
      agentUrl: options.agentUrl,
      authToken: options.authToken,
    }),
  );
  await app.listen({ host: options.host, port: options.port });
  const address = app.server.address();
  const port = typeof address === "object" && address?.port ? address.port : options.port;
  return {
    close: async () => {
      await app.close();
    },
    url: createUrl(options.host, port),
  };
}

export function injectInitialConfig(html: string, initialConfig: WebUiInitialConfig): string {
  const script = `<script>window.__DROID_WEBSCR_CONFIG__=${JSON.stringify(initialConfig).replace(/</g, "\\u003c")};</script>`;
  return html.includes("<head>")
    ? html.replace("<head>", `<head>${script}`)
    : html.includes("</head>")
      ? html.replace("</head>", `${script}</head>`)
      : `${script}${html}`;
}

function createUrl(host: string, port: number): string {
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${port}`;
}
