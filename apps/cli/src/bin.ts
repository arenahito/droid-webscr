#!/usr/bin/env node
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectRun, startAgent } from "@droid-webscr/agent";
import packageJson from "../package.json" with { type: "json" };
import { runCli, type RuntimeStartOptions, type WebUiStartOptions } from "./cli.js";
import { resolvePackagedAndroidArtifact, resolvePackagedWebRoot } from "./package-paths.js";
import { createPackagedWebUi, startWebUiRuntime } from "./web-ui-runtime.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function startPackagedRuntime(options: RuntimeStartOptions) {
  const webRoot = resolvePackagedWebRoot(packageRoot);
  return startAgent({
    config: {
      authToken: options.authToken,
      bindHost: options.host,
      clipboard: { enabled: false },
      port: options.port,
    },
    deviceServerArtifact: resolvePackagedAndroidArtifact(packageRoot),
    webUi: createPackagedWebUi(webRoot, { authToken: options.authToken }),
  });
}

async function startPackagedWebUi(options: WebUiStartOptions) {
  return startWebUiRuntime({
    agentUrl: options.agentUrl,
    authToken: options.authToken,
    host: options.host,
    port: options.port,
    staticRoot: resolvePackagedWebRoot(packageRoot),
  });
}

if (isDirectRun(import.meta.url, process.argv)) {
  runCli(process.argv, {
    packageVersion: packageJson.version,
    startRuntime: startPackagedRuntime,
    startWebUi: startPackagedWebUi,
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
