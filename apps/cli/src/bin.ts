#!/usr/bin/env node
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectRun, startAgent } from "@droid-webscr/agent";
import packageJson from "../package.json" with { type: "json" };
import { runCli } from "./cli.js";
import { resolvePackagedAndroidArtifact, resolvePackagedWebRoot } from "./package-paths.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export async function startPackagedRuntime() {
  return startAgent({
    deviceServerArtifact: resolvePackagedAndroidArtifact(packageRoot),
    webUi: {
      staticRoot: resolvePackagedWebRoot(packageRoot),
    },
  });
}

if (isDirectRun(import.meta.url, process.argv)) {
  runCli(process.argv, {
    packageVersion: packageJson.version,
    startRuntime: startPackagedRuntime,
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
