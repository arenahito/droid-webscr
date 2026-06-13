import type { AgentRuntime } from "@droid-webscr/agent";

export interface CliRuntime {
  readonly packageVersion?: string | undefined;
  readonly startRuntime?: (() => Promise<AgentRuntime>) | undefined;
  readonly stderr?: ((value: string) => void) | undefined;
  readonly stdout?: ((value: string) => void) | undefined;
}

export async function runCli(argv: readonly string[], runtime: CliRuntime = {}): Promise<number> {
  const args = argv.slice(2);
  const io = createCliIo(runtime);

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    io.stdout(createCliHelp());
    return 0;
  }

  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    io.stdout(`${runtime.packageVersion ?? "0.0.0"}\n`);
    return 0;
  }

  if (args.length > 0) {
    io.stderr(`Unknown option: ${args.join(" ")}\n\n`);
    io.stderr(createCliHelp());
    return 1;
  }

  const startRuntime = runtime.startRuntime;
  if (!startRuntime) {
    throw new Error("No droid-webscr runtime was configured.");
  }
  const started = await startRuntime();
  io.stdout(`droid-webscr is running at ${started.url}\n`);
  return 0;
}

export function createCliHelp(): string {
  return `Usage: droid-webscr [options]

Starts the integrated droid-webscr local server and web UI.

Options:
  -h, --help       Show this help text
  -v, --version    Show the package version

The web UI and agent API share http://127.0.0.1:7391 by default.
`;
}

function createCliIo(runtime: CliRuntime): {
  readonly stderr: (value: string) => void;
  readonly stdout: (value: string) => void;
} {
  return {
    stderr: runtime.stderr ?? ((value) => process.stderr.write(value)),
    stdout: runtime.stdout ?? ((value) => process.stdout.write(value)),
  };
}
