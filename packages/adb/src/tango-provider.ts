import { AdbProvider } from "./provider.js";

/* v8 ignore next 4 -- Tango native/USB wiring is an adapter boundary for later integration */
export async function createTangoAdbProvider(): Promise<AdbProvider> {
  await import("@yume-chan/adb");
  throw new Error("TangoAdbProvider adapter is not wired yet; use SystemAdbProvider fallback.");
}
