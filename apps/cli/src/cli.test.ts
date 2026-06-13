import { describe, expect, it, vi } from "vitest";
import { createCliHelp, runCli } from "./cli.js";

describe("droid-webscr integrated CLI", () => {
  it("prints help without starting the runtime", async () => {
    const write = vi.fn();
    const start = vi.fn();

    const exitCode = await runCli(["node", "droid-webscr", "--help"], {
      startRuntime: start,
      stderr: write,
      stdout: write,
    });

    expect(exitCode).toBe(0);
    expect(start).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(expect.stringContaining("Usage: droid-webscr"));
  });

  it("prints version without starting the runtime", async () => {
    const write = vi.fn();
    const start = vi.fn();

    const exitCode = await runCli(["node", "droid-webscr", "--version"], {
      packageVersion: "1.2.3",
      startRuntime: start,
      stderr: write,
      stdout: write,
    });

    expect(exitCode).toBe(0);
    expect(start).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith("1.2.3\n");
  });

  it("starts the integrated runtime and prints the unified web URL", async () => {
    const stdout = vi.fn();
    const runtime = { close: vi.fn(), url: "http://127.0.0.1:7391" };
    const start = vi.fn().mockResolvedValue(runtime);

    const exitCode = await runCli(["node", "droid-webscr"], {
      startRuntime: start,
      stderr: vi.fn(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(start).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("http://127.0.0.1:7391"));
  });

  it("rejects unknown arguments with a compact help hint", async () => {
    const stderr = vi.fn();

    const exitCode = await runCli(["node", "droid-webscr", "--wat"], {
      startRuntime: vi.fn(),
      stderr,
      stdout: vi.fn(),
    });

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Unknown option: --wat"));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Usage: droid-webscr"));
  });

  it("documents the unified local URL", () => {
    expect(createCliHelp()).toContain("http://127.0.0.1:7391");
  });
});
