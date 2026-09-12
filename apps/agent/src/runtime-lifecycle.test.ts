import { describe, expect, it, vi } from "vitest";
import { FakeAdbProvider } from "@droid-webscr/adb";
import net from "node:net";
import { startAgent } from "./runtime.js";
import * as artifacts from "./device-server/artifact.js";

describe("runtime UI ownership", () => {
  it("closes the UI provider when artifact resolution fails", async () => {
    const resolveArtifact = vi
      .spyOn(artifacts, "resolveDeviceServerArtifact")
      .mockRejectedValueOnce(new Error("Artifact missing"));
    const close = vi.fn(async () => {});
    try {
      await expect(
        startAgent({
          adbProvider: new FakeAdbProvider([]),
          config: {
            authToken: "secret",
            bindHost: "127.0.0.1",
            port: 7391,
            clipboard: { enabled: false },
          },
          webUi: { close },
        }),
      ).rejects.toThrow("Artifact missing");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      resolveArtifact.mockRestore();
    }
  });

  it("closes the UI provider when the initial listener cannot start", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as net.AddressInfo).port;
    const close = vi.fn(async () => {});
    try {
      await expect(
        startAgent({
          adbProvider: new FakeAdbProvider([]),
          config: {
            authToken: "secret",
            bindHost: "127.0.0.1",
            port,
            clipboard: { enabled: false },
          },
          deviceServerArtifact: { localPath: "test.jar", remotePath: "/data/local/tmp/test.jar" },
          webUi: { close },
        }),
      ).rejects.toThrow("EADDRINUSE");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        blocker.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each([false, true])("keeps the shared UI open after rebind (failure: %s)", async (fail) => {
    const firstPort = await availablePort();
    const secondPort = await availablePort();
    const blocker = net.createServer();
    if (fail) {
      await new Promise<void>((resolve) => blocker.listen(secondPort, "127.0.0.1", resolve));
    }
    const close = vi.fn(async () => {});
    const runtime = await startAgent({
      adbProvider: new FakeAdbProvider([]),
      config: {
        authToken: "secret",
        bindHost: "127.0.0.1",
        port: firstPort,
        clipboard: { enabled: false },
      },
      deviceServerArtifact: { localPath: "test.jar", remotePath: "/data/local/tmp/test.jar" },
      webUi: {
        close,
        renderIndex: async () => (close.mock.calls.length ? "UI CLOSED" : "UI READY"),
      },
    });
    try {
      const response = await fetch(`${runtime.url}/api/config/bind`, {
        method: "PATCH",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({ bindHost: "127.0.0.1", port: secondPort }),
      });
      expect(response.status).toBe(fail ? 500 : 200);
      // Let the previous listener's scheduled close complete before checking the shared provider.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await (await fetch(runtime.url)).text()).toBe("UI READY");
      expect(close).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
      if (fail) {
        await new Promise<void>((resolve, reject) =>
          blocker.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
    expect(close).toHaveBeenCalledTimes(1);
    await runtime.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as net.AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
