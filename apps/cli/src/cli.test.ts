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
      createAuthToken: () => "generated-token",
      startRuntime: start,
      stderr: vi.fn(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(start).toHaveBeenCalledWith({
      authToken: "generated-token",
      host: "127.0.0.1",
      port: 7391,
    });
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Web UI: http://127.0.0.1:7391"));
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("Agent API: http://127.0.0.1:7391"),
    );
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Auth token: generated-token"));
  });

  it("passes host port and explicit auth token to the integrated runtime", async () => {
    const start = vi.fn().mockResolvedValue({ close: vi.fn(), url: "http://127.0.0.1:7400" });

    const exitCode = await runCli(
      ["node", "droid-webscr", "--host", "0.0.0.0", "--port", "7400", "--auth-token", "secret"],
      {
        createAuthToken: () => "generated-token",
        startRuntime: start,
        stderr: vi.fn(),
        stdout: vi.fn(),
      },
    );

    expect(exitCode).toBe(0);
    expect(start).toHaveBeenCalledWith({
      authToken: "secret",
      host: "0.0.0.0",
      port: 7400,
    });
  });

  it("starts local web UI only mode for an existing agent", async () => {
    const stdout = vi.fn();
    const startWebUi = vi.fn().mockResolvedValue({ close: vi.fn(), url: "http://127.0.0.1:7401" });

    const exitCode = await runCli(
      [
        "node",
        "droid-webscr",
        "--agent-url",
        "http://127.0.0.1:7400",
        "--port",
        "7401",
        "--auth-token",
        "secret",
      ],
      {
        startRuntime: vi.fn(),
        startWebUi,
        stderr: vi.fn(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(startWebUi).toHaveBeenCalledWith({
      agentUrl: "http://127.0.0.1:7400",
      authToken: "secret",
      host: "127.0.0.1",
      port: 7401,
    });
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Web UI: http://127.0.0.1:7401"));
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("Agent API: http://127.0.0.1:7400"),
    );
  });

  it("rejects non-local web UI hosts in existing agent mode", async () => {
    const stderr = vi.fn();

    const exitCode = await runCli(
      ["node", "droid-webscr", "--agent-url", "http://127.0.0.1:7400", "--host", "0.0.0.0"],
      {
        startWebUi: vi.fn(),
        stderr,
        stdout: vi.fn(),
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Web UI host must be local"));
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
    expect(createCliHelp()).toContain("--agent-url");
  });
});
