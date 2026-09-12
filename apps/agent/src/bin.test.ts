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
      signalSource: new FakeSignalSource(),
      startAgent: start,
      stderr: vi.fn(),
      stdout: vi.fn(),
    });

    expect(exitCode).toBe(0);
    expect(start).toHaveBeenCalledOnce();
  });

  it("closes the agent once when termination signals overlap", async () => {
    const signals = new FakeSignalSource();
    let finishClose: (() => void) | undefined;
    const closing = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const close = vi.fn(() => closing);

    await runCli(["node", "droid-webscr"], {
      signalSource: signals,
      startAgent: vi.fn().mockResolvedValue({ close, url: "http://127.0.0.1:7391" }),
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

  it("reports an overlapping shutdown failure once", async () => {
    const signals = new FakeSignalSource();
    const close = vi.fn().mockRejectedValue(new Error("close failed"));
    const stderr = vi.fn();
    const previousExitCode = process.exitCode;

    try {
      await runCli(["node", "droid-webscr"], {
        signalSource: signals,
        startAgent: vi.fn().mockResolvedValue({ close, url: "http://127.0.0.1:7391" }),
        stderr,
        stdout: vi.fn(),
      });

      await Promise.all([signals.emit("SIGINT"), signals.emit("SIGTERM")]);

      expect(close).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledWith("Failed to close droid-webscr: close failed\n");
      expect(process.exitCode).toBe(1);
      expect(signals.listenerCount("SIGINT")).toBe(0);
      expect(signals.listenerCount("SIGTERM")).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
    }
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
