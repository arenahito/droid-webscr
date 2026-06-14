import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createDevelopmentWebUi } from "./dev.js";

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
});
