import { SystemAdbProvider } from "@droid-webscr/adb";
import { defaultAgentConfig } from "@droid-webscr/config";
import { pathToFileURL } from "node:url";
import { createFastifyApp } from "./server/create-fastify-app.js";

export async function startAgent() {
  const app = await createFastifyApp({
    adbProvider: new SystemAdbProvider(),
    config: defaultAgentConfig,
  });
  await app.listen({ host: defaultAgentConfig.bindHost, port: defaultAgentConfig.port });
  return app;
}

export function isDirectRun(moduleUrl: string, argv: readonly string[]): boolean {
  const entrypoint = argv[1];
  return entrypoint !== undefined && pathToFileURL(entrypoint).href === moduleUrl;
}

if (isDirectRun(import.meta.url, process.argv)) {
  startAgent().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
