import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveDeviceServerArtifact } from "@droid-webscr/agent";
import { describe, expect, it, vi } from "vitest";
import {
  createDevelopmentWebUi,
  startDevelopmentRuntime,
  type DevelopmentRuntimeDependencies,
} from "./dev.js";

const moduleMocks = vi.hoisted(() => ({
  createViteServer: vi.fn(),
  startAgent: vi.fn(),
}));

vi.mock("@droid-webscr/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@droid-webscr/agent")>()),
  startAgent: moduleMocks.startAgent,
}));

vi.mock("vite", () => ({ createServer: moduleMocks.createViteServer }));

describe("development web UI provider", () => {
  it("creates a Vite middleware provider for the unified agent server", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "droid-webscr-web-"));
    await writeFile(join(webRoot, "index.html"), "<!doctype html><body></body>");
    const close = vi.fn();
    const transformIndexHtml = vi.fn(async (_url: string, html: string) =>
      html.replace("</body>", '<script type="module" src="/@vite/client"></script></body>'),
    );
    const middleware = vi.fn();

    const provider = await createDevelopmentWebUi(
      {
        createViteServer: async () => ({
          close,
          middlewares: middleware,
          transformIndexHtml,
        }),
        webRoot,
      },
      { authToken: "secret" },
    );
    const renderIndex = provider.renderIndex;
    if (!renderIndex) {
      throw new Error("Expected development provider to render index HTML.");
    }
    const html = await renderIndex("/");

    expect(provider.devMiddleware).toBe(middleware);
    expect(html).toContain("/@vite/client");
    expect(html).toContain('"authToken":"secret"');
    await provider.close?.();
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses the workspace build artifact even when a packaged artifact exists", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "droid-webscr-development-"));
    const staleArtifact = join(
      workspaceRoot,
      "apps",
      "cli",
      "android",
      "droid-webscr-server-android.jar",
    );
    const developmentArtifact = join(
      workspaceRoot,
      "android",
      "server",
      "build",
      "droid-webscr-server-android.jar",
    );
    try {
      await mkdir(join(workspaceRoot, "apps", "cli", "android"), { recursive: true });
      await mkdir(join(workspaceRoot, "apps", "cli", "dist"), { recursive: true });
      await mkdir(join(workspaceRoot, "android", "server", "build"), { recursive: true });
      await writeFile(staleArtifact, "stale");
      await writeFile(developmentArtifact, "current");
      const implicitlyResolvedArtifact = await resolveDeviceServerArtifact(
        import.meta.url,
        join(workspaceRoot, "apps", "cli", "dist"),
      );
      expect(await readFile(implicitlyResolvedArtifact.localPath, "utf8")).toBe("stale");
      const provider = { close: vi.fn() };
      const started = { close: vi.fn(), url: "http://127.0.0.1:7391" };
      let consumedArtifact = "";
      moduleMocks.startAgent.mockReset();
      moduleMocks.startAgent.mockImplementation(async (options) => {
        const artifact = options.deviceServerArtifact ?? implicitlyResolvedArtifact;
        consumedArtifact = await readFile(artifact.localPath, "utf8");
        return started;
      });
      moduleMocks.createViteServer.mockResolvedValue({
        close: vi.fn(),
        middlewares: vi.fn(),
        transformIndexHtml: vi.fn(),
      });
      const dependencies: DevelopmentRuntimeDependencies = {
        createWebUi: vi.fn().mockResolvedValue(provider),
        startAgent: moduleMocks.startAgent,
        workspaceRoot,
      };

      await expect(
        startDevelopmentRuntime(
          { authToken: "secret", host: "127.0.0.1", port: 7391 },
          dependencies,
        ),
      ).resolves.toBe(started);
      expect(consumedArtifact).toBe("current");
      expect(moduleMocks.startAgent).toHaveBeenCalledOnce();
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});
