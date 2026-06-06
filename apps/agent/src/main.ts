import { SystemAdbProvider } from "@droid-webscr/adb";
import { defaultAgentConfig } from "@droid-webscr/config";
import { createFastifyApp } from "./server/create-fastify-app.js";

export async function startAgent() {
  const app = await createFastifyApp({
    adbProvider: new SystemAdbProvider(),
    config: defaultAgentConfig,
  });
  await app.listen({ host: defaultAgentConfig.bindHost, port: defaultAgentConfig.port });
  return app;
}
