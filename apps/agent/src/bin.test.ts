import { describe, expect, it, vi } from "vitest";
import { createCliHelp, runCli } from "./bin.js";

describe("droid-webscr CLI", () => {
  it("prints help without starting the agent", async () => {
    const write = vi.fn();
    const start = vi.fn();

    const exitCode = await runCli(["node", "droid-webscr", "--help"], {
      startAgent: start,
      stderr: write,
      stdout: write,
    });

    expect(exitCode).toBe(0);
    expect(start).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(expect.stringContaining("Usage: droid-webscr"));
  });

  it("prints package version without starting the agent", async () => {
    const write = vi.fn();
    const start = vi.fn();

    const exitCode = await runCli(["node", "droid-webscr", "--version"], {
      packageVersion: "1.2.3",
      startAgent: start,
      stderr: write,
      stdout: write,
    });

    expect(exitCode).toBe(0);
    expect(start).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith("1.2.3\n");
  });

  it("starts the agent when no informational flag is passed", async () => {
    const runtime = { close: vi.fn() };
    const start = vi.fn().mockResolvedValue(runtime);

    const exitCode = await runCli(["node", "droid-webscr"], {
      startAgent: start,
      stderr: vi.fn(),
      stdout: vi.fn(),
    });

    expect(exitCode).toBe(0);
    expect(start).toHaveBeenCalledOnce();
  });

  it("rejects unknown arguments with a compact help hint", async () => {
    const stderr = vi.fn();

    const exitCode = await runCli(["node", "droid-webscr", "--wat"], {
      startAgent: vi.fn(),
      stderr,
      stdout: vi.fn(),
    });

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Unknown option: --wat"));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Usage: droid-webscr"));
  });

  it("documents the local agent default", () => {
    expect(createCliHelp()).toContain("http://127.0.0.1:7391");
  });
});
