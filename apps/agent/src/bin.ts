#!/usr/bin/env node
import packageJson from "../package.json" with { type: "json" };
import { isDirectRun, startAgent, type AgentRuntime } from "./runtime.js";

export interface CliIo {
  stderr(value: string): void;
  stdout(value: string): void;
}

export interface CliRuntime {
  readonly packageVersion?: string | undefined;
  readonly startAgent?: (() => Promise<AgentRuntime>) | undefined;
  readonly stderr?: ((value: string) => void) | undefined;
  readonly stdout?: ((value: string) => void) | undefined;
}

export async function runCli(argv: readonly string[], runtime: CliRuntime = {}): Promise<number> {
  const args = argv.slice(2);
  const io = createCliIo(runtime);
  const packageVersion = runtime.packageVersion ?? packageJson.version;
  const start = runtime.startAgent ?? startAgent;

  if (args.length === 0) {
    await start();
    return 0;
  }

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    io.stdout(createCliHelp());
    return 0;
  }

  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    io.stdout(`${packageVersion}\n`);
    return 0;
  }

  io.stderr(`Unknown option: ${args.join(" ")}\n\n`);
  io.stderr(createCliHelp());
  return 1;
}

export function createCliHelp(): string {
  return `Usage: droid-webscr [options]

Starts the local droid-webscr agent.

Options:
  -h, --help       Show this help text
  -v, --version    Show the package version

The agent listens on http://127.0.0.1:7391 by default.
`;
}

function createCliIo(runtime: CliRuntime): CliIo {
  return {
    stderr: runtime.stderr ?? ((value) => process.stderr.write(value)),
    stdout: runtime.stdout ?? ((value) => process.stdout.write(value)),
  };
}

if (isDirectRun(import.meta.url, process.argv)) {
  runCli(process.argv).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
