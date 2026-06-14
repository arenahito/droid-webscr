import { randomBytes } from "node:crypto";
import type { AgentRuntime } from "@droid-webscr/agent";

export interface RuntimeStartOptions {
  readonly authToken: string;
  readonly host: string;
  readonly port: number;
}

export interface WebUiStartOptions extends RuntimeStartOptions {
  readonly agentUrl: string;
}

export interface CliRuntime {
  readonly createAuthToken?: (() => string) | undefined;
  readonly packageVersion?: string | undefined;
  readonly startRuntime?: ((options: RuntimeStartOptions) => Promise<AgentRuntime>) | undefined;
  readonly startWebUi?: ((options: WebUiStartOptions) => Promise<AgentRuntime>) | undefined;
  readonly stderr?: ((value: string) => void) | undefined;
  readonly stdout?: ((value: string) => void) | undefined;
}

interface ParsedOptions extends RuntimeStartOptions {
  readonly agentUrl?: string | undefined;
}

const defaultHost = "127.0.0.1";
const defaultPort = 7391;

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

  const parsed = parseOptions(args, runtime.createAuthToken ?? createAuthToken);
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\n\n`);
    io.stderr(createCliHelp());
    return 1;
  }

  if (parsed.value.agentUrl) {
    if (!isLocalHost(parsed.value.host)) {
      io.stderr("Web UI host must be local when --agent-url is used.\n\n");
      io.stderr(createCliHelp());
      return 1;
    }
    const startWebUi = runtime.startWebUi;
    if (!startWebUi) {
      throw new Error("No droid-webscr web UI runtime was configured.");
    }
    const started = await startWebUi({
      agentUrl: parsed.value.agentUrl,
      authToken: parsed.value.authToken,
      host: parsed.value.host,
      port: parsed.value.port,
    });
    printStartup(io.stdout, {
      agentApiUrl: parsed.value.agentUrl,
      authToken: parsed.value.authToken,
      webUiUrl: started.url,
    });
    return 0;
  }

  const startRuntime = runtime.startRuntime;
  if (!startRuntime) {
    throw new Error("No droid-webscr runtime was configured.");
  }
  const started = await startRuntime({
    authToken: parsed.value.authToken,
    host: parsed.value.host,
    port: parsed.value.port,
  });
  printStartup(io.stdout, {
    agentApiUrl: started.url,
    authToken: parsed.value.authToken,
    webUiUrl: started.url,
  });
  return 0;
}

export function createCliHelp(): string {
  return `Usage: droid-webscr [options]

Starts the integrated droid-webscr local server and web UI.

Options:
  --host <host>          Agent API bind host, or local Web UI host with --agent-url
  --port <port>          TCP port, or 0 to use an available port
  --auth-token <token>   Bearer token; generated for this process when omitted
  --agent-url <url>      Connect a local Web UI to an existing droid-webscr agent
  -h, --help             Show this help text
  -v, --version          Show the package version

Examples:
  droid-webscr
  droid-webscr --port 7400
  droid-webscr --host 0.0.0.0 --port 7400
  droid-webscr --agent-url http://127.0.0.1:7400 --port 7401 --auth-token secret

The web UI is local-only. The agent API uses http://127.0.0.1:7391 by default.
`;
}

function parseOptions(
  args: readonly string[],
  createToken: () => string,
):
  | { readonly ok: true; readonly value: ParsedOptions }
  | { readonly ok: false; readonly error: string } {
  let agentUrl: string | undefined;
  let authToken: string | undefined;
  let host = defaultHost;
  let port = defaultPort;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--host") {
      const value = readOptionValue(args, index, arg);
      if (!value.ok) {
        return value;
      }
      host = value.value;
      index += 1;
      continue;
    }
    if (arg === "--port") {
      const value = readOptionValue(args, index, arg);
      if (!value.ok) {
        return value;
      }
      const parsedPort = Number(value.value);
      if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65_535) {
        return { error: "port must be a valid TCP port", ok: false };
      }
      port = parsedPort;
      index += 1;
      continue;
    }
    if (arg === "--auth-token") {
      const value = readOptionValue(args, index, arg);
      if (!value.ok) {
        return value;
      }
      if (value.value.length === 0) {
        return { error: "auth token must not be empty", ok: false };
      }
      authToken = value.value;
      index += 1;
      continue;
    }
    if (arg === "--agent-url") {
      const value = readOptionValue(args, index, arg);
      if (!value.ok) {
        return value;
      }
      if (!isHttpUrl(value.value)) {
        return { error: "agent URL must be an http or https URL", ok: false };
      }
      agentUrl = trimTrailingSlash(value.value);
      index += 1;
      continue;
    }
    return { error: `Unknown option: ${arg}`, ok: false };
  }

  return {
    ok: true,
    value: {
      agentUrl,
      authToken: authToken ?? createToken(),
      host,
      port,
    },
  };
}

function readOptionValue(
  args: readonly string[],
  index: number,
  option: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string } {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    return { error: `${option} requires a value`, ok: false };
  }
  return { ok: true, value };
}

function createAuthToken(): string {
  return randomBytes(32).toString("base64url");
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function printStartup(
  stdout: (value: string) => void,
  values: { readonly agentApiUrl: string; readonly authToken: string; readonly webUiUrl: string },
): void {
  stdout(`Web UI: ${values.webUiUrl}\n`);
  stdout(`Agent API: ${values.agentApiUrl}\n`);
  stdout(`Auth token: ${values.authToken}\n`);
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
