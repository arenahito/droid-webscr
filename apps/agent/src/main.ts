import { isDirectRun, startAgent } from "./runtime.js";

export * from "./runtime.js";

/* v8 ignore next 5 -- CLI bootstrap failure handling needs process-level side effects. */
if (isDirectRun(import.meta.url, process.argv)) {
  startAgent().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
