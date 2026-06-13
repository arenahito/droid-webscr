import { describe, expect, it } from "vitest";

async function readCss(): Promise<string> {
  // @ts-expect-error Vitest runs this contract in Node, while the web tsconfig omits Node types.
  const { readFile } = await import("node:fs/promises");
  const attempts = await Promise.allSettled(
    ["apps/web/src/index.css", "src/index.css"].map((path) => readFile(path, "utf8")),
  );
  const successfulAttempt = attempts.find((attempt) => attempt.status === "fulfilled");
  if (successfulAttempt?.status === "fulfilled") {
    return successfulAttempt.value;
  }
  throw new Error("Unable to read apps/web/src/index.css");
}

async function readButtonComponent(): Promise<string> {
  // @ts-expect-error Vitest runs this contract in Node, while the web tsconfig omits Node types.
  const { readFile } = await import("node:fs/promises");
  const attempts = await Promise.allSettled(
    ["apps/web/src/components/ui/button.tsx", "src/components/ui/button.tsx"].map((path) =>
      readFile(path, "utf8"),
    ),
  );
  const successfulAttempt = attempts.find((attempt) => attempt.status === "fulfilled");
  if (successfulAttempt?.status === "fulfilled") {
    return successfulAttempt.value;
  }
  throw new Error("Unable to read apps/web/src/components/ui/button.tsx");
}

function cssBlock(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(source);
  if (!match?.groups?.body) {
    throw new Error(`Missing CSS block for ${selector}`);
  }
  return match.groups.body;
}

describe("theme CSS contract", () => {
  it("keeps light-theme app chrome free of dark-only color literals", async () => {
    const css = await readCss();
    const lightChromeSelectors = [
      ".topbar",
      ".sidebar-section > button",
      ".control-rail",
      ".control-rail button",
      ".log-drawer",
      ".log-lines",
    ];
    const darkOnlyLiterals = ["rgb(19 27 36", "#111821", "#131b24", "#0b1117", "#d6e0ea"];

    for (const selector of lightChromeSelectors) {
      const block = cssBlock(css, selector);
      const leakedLiterals = darkOnlyLiterals.filter((literal) => block.includes(literal));
      expect(leakedLiterals, selector).toEqual([]);
    }
  });

  it("keeps toast colors independent from bright theme primary colors", async () => {
    const css = await readCss();
    const toastBlock = cssBlock(css, ".toast");

    expect(toastBlock).toContain("var(--color-toast-background)");
    expect(toastBlock).toContain("var(--color-toast-foreground)");
    expect(toastBlock).not.toContain("var(--color-primary)");
    expect(toastBlock).not.toContain("var(--color-primary-foreground)");
  });

  it("marks enabled clickable form controls with a pointer cursor", async () => {
    const css = await readCss();

    expect(css).toMatch(
      /button:not\(:disabled\),\s*select:not\(:disabled\)\s*\{\s*cursor:\s*pointer;\s*\}/,
    );
    expect(css).toMatch(/button:disabled,\s*select:disabled\s*\{\s*cursor:\s*not-allowed;\s*\}/);
  });

  it("keeps disabled buttons hoverable so the disabled cursor is visible", async () => {
    const buttonComponent = await readButtonComponent();

    expect(buttonComponent).not.toContain("disabled:pointer-events-none");
  });

  it("keeps access panel heading spacing aligned with sidebar sections", async () => {
    const css = await readCss();
    const sidebarSectionBlock = cssBlock(css, ".sidebar-section");
    const accessPanelBlock = cssBlock(css, ".access-panel");

    expect(sidebarSectionBlock).toContain("gap: 10px");
    expect(accessPanelBlock).toContain("gap: 10px");
  });

  it("styles app scrollbars as a thin shared chrome control", async () => {
    const css = await readCss();
    const globalBlock = cssBlock(css, "*");
    const webkitScrollbarBlock = cssBlock(css, "*::-webkit-scrollbar");
    const webkitThumbBlock = cssBlock(css, "*::-webkit-scrollbar-thumb");
    const webkitTrackBlock = cssBlock(css, "*::-webkit-scrollbar-track");

    expect(css).toContain("--color-scrollbar-thumb");
    expect(css).toContain("--color-scrollbar-track");
    expect(globalBlock).toContain("scrollbar-color: var(--color-scrollbar-thumb) transparent");
    expect(globalBlock).toContain("scrollbar-width: thin");
    expect(webkitScrollbarBlock).toContain("height: 8px");
    expect(webkitScrollbarBlock).toContain("width: 8px");
    expect(webkitThumbBlock).toContain("background: var(--color-scrollbar-thumb)");
    expect(webkitTrackBlock).toContain("background: var(--color-scrollbar-track)");
  });

  it("styles device log rows by normalized log level", async () => {
    const css = await readCss();
    const levels = ["verbose", "debug", "info", "warn", "error"];

    for (const level of levels) {
      const lineBlock = cssBlock(css, `.log-line-level-${level}`);
      const labelBlock = cssBlock(css, `.log-level.log-${level}`);
      expect(lineBlock).toContain(`var(--color-log-${level})`);
      expect(labelBlock).toContain(`var(--color-log-${level}-strong)`);
    }
    expect(css).toContain("--color-log-debug: var(--color-log-verbose)");
    expect(css).toContain("--color-log-debug-strong: var(--color-log-verbose-strong)");
    expect(css).toContain("--color-log-info: var(--control-text)");
    expect(css).toContain("--color-log-info-strong: var(--control-text)");
  });

  it("keeps structured device log columns from overlapping", async () => {
    const css = await readCss();
    const structuredBlock = cssBlock(css, ".log-line-structured");
    const wrapStructuredBlock = cssBlock(css, ".log-lines.wrap-lines .log-line-structured");
    const messageBlock = cssBlock(css, ".log-line-message");

    expect(structuredBlock).toContain("display: inline-grid");
    expect(structuredBlock).toContain(
      "grid-template-columns: max-content 2ch max-content max-content",
    );
    expect(structuredBlock).toContain("min-width: max-content");
    expect(wrapStructuredBlock).toContain(
      "grid-template-columns: max-content 2ch max-content minmax(0, 1fr)",
    );
    expect(wrapStructuredBlock).toContain("min-width: 0");
    expect(messageBlock).toContain("min-width: 0");
  });

  it("keeps device log tail controls compact in the toolbar", async () => {
    const css = await readCss();
    const tailButtonBlock = cssBlock(css, ".log-toolbar .log-tail-toggle");
    const tailButtonIconBlock = cssBlock(css, ".log-toolbar .log-tail-toggle svg");

    expect(tailButtonBlock).toContain("font-size: 11px");
    expect(tailButtonBlock).toContain("height: 28px");
    expect(tailButtonBlock).toContain("gap: 6px");
    expect(tailButtonIconBlock).toContain("height: 14px");
    expect(tailButtonIconBlock).toContain("width: 14px");
  });
});
