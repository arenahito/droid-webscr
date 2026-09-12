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
      signalSource: new FakeSignalSource(),
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

  it("closes the runtime once when termination signals overlap", async () => {
    const signals = new FakeSignalSource();
    let finishClose: (() => void) | undefined;
    const closing = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const close = vi.fn(() => closing);

    await runCli(["node", "droid-webscr"], {
      createAuthToken: () => "generated-token",
      signalSource: signals,
      startRuntime: vi.fn().mockResolvedValue({
        close,
        url: "http://127.0.0.1:7391",
      }),
      stderr: vi.fn(),
      stdout: vi.fn(),
    });

    const interrupt = signals.emit("SIGINT");
    const terminate = signals.emit("SIGTERM");
    expect(close).toHaveBeenCalledTimes(1);

    finishClose?.();
    await Promise.all([interrupt, terminate]);

    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("passes host port and explicit auth token to the integrated runtime", async () => {
    const start = vi.fn().mockResolvedValue({ close: vi.fn(), url: "http://127.0.0.1:7400" });

    const exitCode = await runCli(
      ["node", "droid-webscr", "--host", "0.0.0.0", "--port", "7400", "--auth-token", "secret"],
      {
        createAuthToken: () => "generated-token",
        signalSource: new FakeSignalSource(),
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
        signalSource: new FakeSignalSource(),
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

type Signal = "SIGINT" | "SIGTERM";

class FakeSignalSource {
  readonly #listeners = new Map<Signal, Set<() => void | Promise<void>>>();

  once(signal: Signal, listener: () => void | Promise<void>): void {
    const listeners = this.#listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(signal, listeners);
  }

  off(signal: Signal, listener: () => void | Promise<void>): void {
    this.#listeners.get(signal)?.delete(listener);
  }

  async emit(signal: Signal): Promise<void> {
    const listeners = [...(this.#listeners.get(signal) ?? [])];
    this.#listeners.delete(signal);
    await Promise.all(listeners.map((listener) => listener()));
  }

  listenerCount(signal: Signal): number {
    return this.#listeners.get(signal)?.size ?? 0;
  }
}
