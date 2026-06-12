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
    expect(css).toMatch(/select:disabled\s*\{\s*cursor:\s*not-allowed;\s*\}/);
  });
});
