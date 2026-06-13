import { describe, expect, it } from "vitest";
import { FakeAdbProvider } from "@droid-webscr/adb";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { isDirectRun, startAgent } from "./main.js";

describe("isDirectRun", () => {
  it("accepts the current module URL when Node runs the compiled entrypoint", () => {
    const entrypoint = "C:/repo/apps/agent/dist/main.js";
    expect(isDirectRun(pathToFileURL(entrypoint).href, ["/node", entrypoint])).toBe(true);
  });

  it("rejects imports from other entrypoints", () => {
    expect(
      isDirectRun("file:///repo/apps/agent/dist/main.js", ["/node", "/repo/tools/dev.js"]),
    ).toBe(false);
  });
});

describe("startAgent", () => {
  it("rebinds a real listener on the same port and closes the active replacement", async () => {
    const port = await getOpenPort();
    const secondPort = await getOpenPort();
    const runtime = await startAgent({
      adbProvider: new FakeAdbProvider([]),
      config: {
        authToken: undefined,
        bindHost: "127.0.0.1",
        clipboard: { enabled: false },
        port,
      },
      deviceServerArtifact: testDeviceServerArtifact,
    });

    const rebind = await fetch(`http://127.0.0.1:${port}/api/config/bind`, {
      body: JSON.stringify({ bindHost: "localhost", port }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    const noOpRebind = await fetch(`http://localhost:${port}/api/config/bind`, {
      body: JSON.stringify({ bindHost: "localhost", port }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    await fetch(`http://localhost:${port}/api/config/clipboard`, {
      body: JSON.stringify({ enabled: true }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    await fetch(`http://localhost:${port}/api/config/bind`, {
      body: JSON.stringify({ bindHost: "127.0.0.1", port: secondPort }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    const config = await fetch(`http://127.0.0.1:${secondPort}/api/config`);

    expect(rebind.status).toBe(200);
    expect(noOpRebind.status).toBe(200);
    expect(await config.json()).toEqual({
      bindHost: "127.0.0.1",
      clipboardEnabled: true,
      port: secondPort,
    });

    await runtime.close();
    await expect(fetch(`http://127.0.0.1:${secondPort}/api/health`)).rejects.toThrow();
  });

  it("serializes rapid rebinds across ports", async () => {
    const firstPort = await getOpenPort();
    const secondPort = await getOpenPort();
    const runtime = await startAgent({
      adbProvider: new FakeAdbProvider([]),
      config: {
        authToken: undefined,
        bindHost: "127.0.0.1",
        clipboard: { enabled: false },
        port: firstPort,
      },
      deviceServerArtifact: testDeviceServerArtifact,
    });

    const firstRebind = await fetch(`http://127.0.0.1:${firstPort}/api/config/bind`, {
      body: JSON.stringify({ bindHost: "127.0.0.1", port: secondPort }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    const secondRebind = await fetch(`http://127.0.0.1:${secondPort}/api/config/bind`, {
      body: JSON.stringify({ bindHost: "127.0.0.1", port: firstPort }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    const config = await fetch(`http://127.0.0.1:${firstPort}/api/config`);

    expect(firstRebind.status).toBe(200);
    expect(secondRebind.status).toBe(200);
    expect(await config.json()).toEqual({
      bindHost: "127.0.0.1",
      clipboardEnabled: false,
      port: firstPort,
    });

    await runtime.close();
  });

  it("keeps the current listener alive when rebinding to an occupied port fails", async () => {
    const firstPort = await getOpenPort();
    const occupiedPort = await getOpenPort();
    const blocker = net.createServer();
    await listen(blocker, occupiedPort);
    const runtime = await startAgent({
      adbProvider: new FakeAdbProvider([]),
      config: {
        authToken: undefined,
        bindHost: "127.0.0.1",
        clipboard: { enabled: false },
        port: firstPort,
      },
      deviceServerArtifact: testDeviceServerArtifact,
    });

    const failed = await fetch(`http://127.0.0.1:${firstPort}/api/config/bind`, {
      body: JSON.stringify({ bindHost: "127.0.0.1", port: occupiedPort }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    const health = await fetch(`http://127.0.0.1:${firstPort}/api/health`);

    expect(failed.status).toBe(500);
    expect(health.status).toBe(200);

    await runtime.close();
    await closeServer(blocker);
  });
});

const testDeviceServerArtifact = {
  localPath: "test-droid-webscr-server.jar",
  remotePath: "/data/local/tmp/test-droid-webscr-server.jar",
};

async function getOpenPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("Failed to allocate a TCP port."));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function listen(server: net.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
